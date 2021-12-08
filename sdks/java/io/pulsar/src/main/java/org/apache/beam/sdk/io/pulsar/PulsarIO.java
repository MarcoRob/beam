package org.apache.beam.sdk.io.pulsar;

import com.google.auto.value.AutoValue;
import org.apache.beam.sdk.coders.*;
import org.apache.beam.sdk.transforms.*;
import org.apache.beam.sdk.values.PBegin;
import org.apache.beam.sdk.values.PCollection;
import org.apache.beam.sdk.values.PDone;
import org.apache.pulsar.client.api.Message;

import org.apache.pulsar.client.api.MessageId;
import org.apache.pulsar.client.api.Schema;
import org.apache.pulsar.common.api.EncryptionContext;
import org.checkerframework.checker.nullness.qual.Nullable;
import org.joda.time.Instant;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public class PulsarIO {

    /** Static class, prevent instantiation. */
    private PulsarIO() {}

    public static Read read() {
        return new AutoValue_PulsarIO_Read.Builder()
                .build();
    }

    @AutoValue
    @SuppressWarnings({"rawtypes"})
    public abstract static class Read extends PTransform<PBegin, PCollection<PulsarMessage>> {

        abstract @Nullable String getClientUrl();
        abstract @Nullable String getTopic();
        abstract @Nullable Long getStartTimestamp();
        abstract @Nullable SerializableFunction<Message<byte[]>, Instant> getExtractOutputTimestampFn();
        abstract Builder builder();

        @AutoValue.Builder
        abstract static class Builder {
            abstract Builder setClientUrl(String url);
            abstract Builder setTopic(String topic);
            abstract Builder setStartTimestamp(Long timestamp);
            abstract Builder setExtractOutputTimestampFn(SerializableFunction<Message<byte[]>, Instant> fn);
            abstract Read build();
        }

        public Read withClientUrl(String url) {
            return builder().setClientUrl(url).build();
        }

        public Read withTopic(String topic) {
            return builder().setTopic(topic).build();
        }

        public Read withStartTimestamp(Long timestamp) {
            return builder().setStartTimestamp(timestamp).build();
        }

        public Read withExtractOutputTimestampFn(SerializableFunction<Message<byte[]>, Instant> fn) {
            return builder().setExtractOutputTimestampFn(fn).build();
        }

        public Read withPublishTime() {
            return withExtractOutputTimestampFn(ExtractOutputTimestampFn.usePublishTime());
        }

        public Read withProcessingTime() {
            return withExtractOutputTimestampFn(ExtractOutputTimestampFn.useProcessingTime());
        }

        @Override
        public PCollection<PulsarMessage> expand(PBegin input) {
            return input
                    .apply(
                            Create.of(
                                    PulsarSourceDescriptor.of(getTopic(), getStartTimestamp(), getClientUrl())))
                    .apply(
                            ParDo.of(
                                    new ReadFromPulsarDoFn(this)))
                    .setCoder(PulsarMessageCoder.of());

        }
    }


    public static Write write() {
        return new AutoValue_PulsarIO_Write.Builder()
                .build();
    }

    @AutoValue
    @SuppressWarnings({"rawtypes"})
    public abstract static class Write extends PTransform<PCollection<Message<byte[]>>, PDone> {

        abstract @Nullable String getTopic();
        abstract String getClientUrl();
        abstract Builder builder();

        @AutoValue.Builder
        abstract static class Builder {
            abstract Builder setTopic(String topic);
            abstract Builder setClientUrl(String clientUrl);
            abstract Write build();

        }

        public Write withTopic(String topic) {
            return builder().setTopic(topic).build();
        }

        public Write withClientUrl(String clientUrl) {
            return builder().setClientUrl(clientUrl).build();
        }

        @Override
        public PDone expand(PCollection<Message<byte[]>> input) {
            //TODO checkargument (missing topic?)
            input.apply(ParDo.of(new PulsarWriter(this)));
            return PDone.in(input.getPipeline());
        }
    }


    static class ExtractOutputTimestampFn {
        public static SerializableFunction<Message<byte[]>, Instant> useProcessingTime() {
            return record -> Instant.now();
        }

        public static SerializableFunction<Message<byte[]>, Instant> usePublishTime() {
            return record -> new Instant(record.getPublishTime());
        }
    }
}