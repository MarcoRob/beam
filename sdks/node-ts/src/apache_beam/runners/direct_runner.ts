import * as uuid from "uuid";
import * as protobufjs from "protobufjs";
import Long from "long";

import * as runnerApi from "../proto/beam_runner_api";
import * as fnApi from "../proto/beam_fn_api";
import { PTransform, PCollection } from "../proto/beam_runner_api";
import { ProcessBundleDescriptor } from "../proto/beam_fn_api";
import { JobState_Enum } from "../proto/beam_job_api";

import { Pipeline, Root, Impulse, GroupByKey } from "../base";
import { Runner, PipelineResult } from "./runner";
import * as worker from "../worker/worker";
import * as operators from "../worker/operators";
import { createStateKey } from "../worker/pardo_context";
import * as state from "../worker/state";
import { ParDo } from "../transforms/pardo";
import {
  Window,
  GlobalWindow,
  Instant,
  PaneInfo,
  WindowedValue,
} from "../values";
import { PaneInfoCoder } from "../coders/standard_coders";
import { Coder, Context as CoderContext } from "../coders/coders";
import { fakeSeralize, fakeDeserialize } from "../base";

export class DirectRunner extends Runner {
  // All the operators for a given pipeline should share the same state.
  // This global mapping allows operators to look up a shared state object for
  // a given pipeline on deserialization.
  static inMemoryStatesRefs: Map<string, InMemoryStateProvider> = new Map();

  async runPipeline(p): Promise<PipelineResult> {
    // console.dir(p.proto, { depth: null });

    const stateProvider = new InMemoryStateProvider();
    const stateCacheRef = uuid.v4();
    DirectRunner.inMemoryStatesRefs.set(stateCacheRef, stateProvider);

    try {
      const proto = rewriteSideInputs(p.proto, stateCacheRef);
      const descriptor: ProcessBundleDescriptor = {
        id: "",
        transforms: proto.components!.transforms,
        pcollections: proto.components!.pcollections,
        windowingStrategies: proto.components!.windowingStrategies,
        coders: proto.components!.coders,
        environments: proto.components!.environments,
      };

      const processor = new worker.BundleProcessor(
        descriptor,
        null!,
        new state.CachingStateProvider(stateProvider),
        [Impulse.urn]
      );
      await processor.process("bundle_id");

      return {
        waitUntilFinish: (duration?: number) =>
          Promise.resolve(JobState_Enum.DONE),
      };
    } finally {
      DirectRunner.inMemoryStatesRefs.delete(stateCacheRef);
    }
  }
}

// Only to be used in direct runner, as this will fire an element per worker, not per pipeline.
class DirectImpulseOperator implements operators.IOperator {
  receiver: operators.Receiver;

  constructor(
    transformId: string,
    transform: PTransform,
    context: operators.OperatorContext
  ) {
    this.receiver = context.getReceiver(
      onlyElement(Object.values(transform.outputs))
    );
  }

  process(wvalue: WindowedValue<any>) {
    return operators.NonPromise;
  }

  async startBundle() {
    this.receiver.receive({
      value: new Uint8Array(),
      windows: [new GlobalWindow()],
      pane: PaneInfoCoder.ONE_AND_ONLY_FIRING,
      timestamp: Long.fromValue("-9223372036854775"), // TODO: Pull constant out of proto, or at least as a constant elsewhere.
    });
  }

  async finishBundle() {}
}

operators.registerOperator(Impulse.urn, DirectImpulseOperator);

// Only to be used in direct runner, as this will only group within a single bundle.
// TODO: This could be used as a base for the PGBKOperation operator,
// and then this class could simply invoke that with an unbounded size and the
// concat-to-list CombineFn.
class DirectGbkOperator implements operators.IOperator {
  receiver: operators.Receiver;
  groups: Map<any, any[]>;
  keyCoder: Coder<any>;
  windowCoder: Coder<any>;

  constructor(
    transformId: string,
    transform: PTransform,
    context: operators.OperatorContext
  ) {
    this.receiver = context.getReceiver(
      onlyElement(Object.values(transform.outputs))
    );
    const inputPc =
      context.descriptor.pcollections[
        onlyElement(Object.values(transform.inputs))
      ];
    this.keyCoder = context.pipelineContext.getCoder(
      context.descriptor.coders[inputPc.coderId].componentCoderIds[0]
    );
    const windowingStrategy =
      context.descriptor.windowingStrategies[inputPc.windowingStrategyId];
    // TODO: Check or implement triggers, etc.
    if (
      windowingStrategy.mergeStatus != runnerApi.MergeStatus_Enum.NON_MERGING
    ) {
      throw new Error("Non-merging WindowFn: " + windowingStrategy);
    }
    this.windowCoder = context.pipelineContext.getCoder(
      windowingStrategy.windowCoderId
    );
  }

  process(wvalue: WindowedValue<any>) {
    // TODO: Assert non-merging, EOW timestamp, etc.
    for (const window of wvalue.windows) {
      const wkey =
        encodeToBase64(window, this.windowCoder) +
        " " +
        encodeToBase64(wvalue.value.key, this.keyCoder);
      if (!this.groups.has(wkey)) {
        this.groups.set(wkey, []);
      }
      this.groups.get(wkey)!.push(wvalue.value.value);
    }
    return operators.NonPromise;
  }

  async startBundle() {
    this.groups = new Map();
  }

  async finishBundle() {
    const this_ = this;
    for (const [wkey, values] of this.groups) {
      const [encodedWindow, encodedKey] = wkey.split(" ");
      const window = decodeFromBase64(encodedWindow, this.windowCoder);
      const maybePromise = this_.receiver.receive({
        value: {
          key: decodeFromBase64(encodedKey, this.keyCoder),
          value: values,
        },
        windows: [window],
        timestamp: window.maxTimestamp(),
        pane: PaneInfoCoder.ONE_AND_ONLY_FIRING,
      });
      if (maybePromise != operators.NonPromise) {
        await maybePromise;
      }
    }
    this.groups = null!;
  }
}

operators.registerOperator(GroupByKey.urn, DirectGbkOperator);

/**
 * Rewrites the pipeline to be suitable for running as a single "bundle."
 *
 * Given a pipeline of the form
 *
 *    ...          ...
 *     |            |
 * mainPColl    sidePColl
 *     |            |
 *   parDo <-------/
 *     |
 *    ...
 *
 * Rewrites this to be in the form.
 *
 *    ...          ...
 *     |            |
 * mainPColl    sidePColl
 *     |            |
 *     |      collectSideOp
 *     |            |
 *     |        emptyPColl
 *     | <- - - - -/
 *     |
 *  bufferOp
 *     |
 * mainPcollCopy
 *     |
 *   parDo <----- sidePCollCopy
 *
 * Where collectSideOp collects its inputs for future retrieval and bufferOp
 * buffers all its inputs, invoking the downstream parDo only once finishBundle
 * is called. The dotted line from collectSideOp to bufferOp is not used to
 * pass any data, but acts as a control edge forcing bufferOp to be finished
 * only after all side inputs have been fully collected.
 *
 * A sidePCollCopy is also placed in the graph to allow for lookup of metadata
 * when executing the parDo operaton.
 */
function rewriteSideInputs(p: runnerApi.Pipeline, pipelineStateRef: string) {
  function uniqueName(container, base) {
    let name = base;
    let counter = 0;
    while (container[name]) {
      name = base + counter++;
    }
    return name;
  }

  p = runnerApi.Pipeline.clone(p);
  const pcolls = p.components!.pcollections;
  const transforms = p.components!.transforms;
  for (const [transformId, transform] of Object.entries(transforms)) {
    if (
      transform.spec != undefined &&
      transform.spec.urn == ParDo.urn &&
      Object.keys(transform.inputs).length > 1
    ) {
      const spec = runnerApi.ParDoPayload.fromBinary(transform.spec!.payload);

      // Figure out which input is the main input.
      // TODO: Is there a clean way to do a set difference?
      let mainPCollTag: string = undefined!;
      for (const tag of Object.keys(transform.inputs)) {
        if (!spec.sideInputs[tag]) {
          if (mainPCollTag) throw new Error("Multiple non-side inputs.");
          mainPCollTag = tag;
        }
      }
      if (!mainPCollTag) throw new Error("Missing non-side input.");

      // Add the extra logic for each of the side inputs.
      const bufferInputs = { mainPCollTag: transform.inputs[mainPCollTag] };
      for (const side of Object.keys(spec.sideInputs)) {
        const sidePCollId = transform.inputs[side];
        const sideCopyId = uniqueName(pcolls, sidePCollId + "-" + side);
        pcolls[sideCopyId] = pcolls[sidePCollId];
        transform.inputs[side] = sideCopyId;
        const controlPCollId = uniqueName(
          pcolls,
          sidePCollId + "-" + side + "-control"
        );
        pcolls[controlPCollId] = pcolls[transform.inputs[mainPCollTag]];
        bufferInputs[side] = controlPCollId;
        const collectTransformId = uniqueName(
          transforms,
          transformId + "-" + side + "-collect"
        );
        transforms[collectTransformId] = runnerApi.PTransform.create({
          spec: {
            urn: CollectSideOperator.urn,
            payload: fakeSeralize({
              transformId: transformId,
              sideInputId: side,
              accessPattern: spec.sideInputs[side].accessPattern!.urn,
              pipelineStateRef: pipelineStateRef,
            }),
          },
          inputs: { input: sidePCollId },
          outputs: { out: controlPCollId },
        });
      }

      // Add the buffering operator.
      const bufferId = uniqueName(transforms, transformId + "-buffer");
      const bufferOutputId = uniqueName(pcolls, bufferId + "-out");
      pcolls[bufferOutputId] = pcolls[mainPCollTag];
      transforms[bufferId] = runnerApi.PTransform.create({
        spec: { urn: BufferOperator.urn, payload: new Uint8Array() },
        inputs: bufferInputs,
        outputs: { out: bufferOutputId },
      });
      transform.inputs[mainPCollTag] = bufferOutputId;
    }
  }

  return p;
}

class CollectSideOperator implements operators.IOperator {
  static urn = "beam:transforms:node_ts_direct:collect_side:v1";

  stateProvider: InMemoryStateProvider;

  parDoTransformId: string;
  accessPattern: string;
  sideInputId: string;

  receiver: operators.Receiver;
  windowCoder: Coder<Window>;
  elementCoder: Coder<any>;

  constructor(
    transformId: string,
    transform: PTransform,
    context: operators.OperatorContext
  ) {
    this.receiver = context.getReceiver(
      onlyElement(Object.values(transform.outputs))
    );
    const payload = fakeDeserialize(transform.spec!.payload!);
    this.parDoTransformId = payload.transformId;
    this.accessPattern = payload.accessPattern;
    this.sideInputId = payload.sideInputId;
    this.stateProvider = DirectRunner.inMemoryStatesRefs.get(
      payload.pipelineStateRef
    )!;

    const inputPc =
      context.descriptor.pcollections[
        onlyElement(Object.values(transform.inputs))
      ];
    this.elementCoder = context.pipelineContext.getCoder(inputPc.coderId);
    const windowingStrategy =
      context.descriptor.windowingStrategies[inputPc.windowingStrategyId];
    this.windowCoder = context.pipelineContext.getCoder(
      windowingStrategy.windowCoderId
    );
  }

  async startBundle() {}

  process(wvalue: WindowedValue<any>) {
    for (const window of wvalue.windows) {
      const writer = new protobufjs.Writer();
      this.elementCoder.encode(
        wvalue.value,
        writer,
        CoderContext.needsDelimiters
      );
      const encodedElement = writer.finish();
      this.stateProvider.appendState(
        createStateKey(
          this.parDoTransformId,
          this.accessPattern,
          this.sideInputId,
          window,
          this.windowCoder
        ),
        encodedElement
      );
    }
    return operators.NonPromise;
  }

  async finishBundle() {}
}

operators.registerOperator(CollectSideOperator.urn, CollectSideOperator);

class BufferOperator implements operators.IOperator {
  static urn = "beam:transforms:node_ts_direct:buffer:v1";
  receiver: operators.Receiver;
  elements: WindowedValue<any>[];

  constructor(
    transformId: string,
    transform: PTransform,
    context: operators.OperatorContext
  ) {
    this.receiver = context.getReceiver(
      onlyElement(Object.values(transform.outputs))
    );
  }

  process(wvalue: WindowedValue<any>) {
    this.elements.push(wvalue);
    return operators.NonPromise;
  }

  async startBundle() {
    this.elements = [];
  }

  async finishBundle() {
    for (const element of this.elements) {
      const maybePromise = this.receiver.receive(element);
      if (maybePromise != operators.NonPromise) {
        await maybePromise;
      }
    }
  }
}

operators.registerOperator(BufferOperator.urn, BufferOperator);

class InMemoryStateProvider implements state.StateProvider {
  chunks: Map<string, Uint8Array[]> = new Map();

  getState<T>(
    stateKey: fnApi.StateKey,
    decode: (data: Uint8Array) => T
  ): state.MaybePromise<T> {
    return {
      type: "value",
      value: decode(state.Uint8ArrayConcat(this.getStateEntry(stateKey))),
    };
  }

  appendState(stateKey: fnApi.StateKey, encodedData: Uint8Array) {
    this.getStateEntry(stateKey).push(encodedData);
  }

  getStateEntry<T>(stateKey: fnApi.StateKey) {
    const cacheKey = Buffer.from(fnApi.StateKey.toBinary(stateKey)).toString(
      "base64"
    );
    if (!this.chunks.has(cacheKey)) {
      this.chunks.set(cacheKey, []);
    }
    return this.chunks.get(cacheKey)!;
  }
}

/////

export function encodeToBase64<T>(element: T, coder: Coder<T>): string {
  const writer = new protobufjs.Writer();
  coder.encode(element, writer, CoderContext.wholeStream);
  return Buffer.from(writer.finish()).toString("base64");
}

export function decodeFromBase64<T>(s: string, coder: Coder<T>): T {
  return coder.decode(
    new protobufjs.Reader(Buffer.from(s, "base64")),
    CoderContext.wholeStream
  );
}

function onlyElement<T>(arg: T[]): T {
  if (arg.length > 1) {
    Error("Expecting exactly one element.");
  }
  return arg[0];
}
