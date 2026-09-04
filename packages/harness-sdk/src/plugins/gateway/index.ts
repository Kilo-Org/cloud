import { Effect, Layer, Option, Ref, Stream } from 'effect';
import {
  abortHandle,
  post,
  withAbort,
  type AbortHandle,
  type HttpCaller,
  type HttpConfig,
} from './http.js';
import { ModelCatalog, type ModelCatalogService } from '../../core/catalog.js';
import {
  ModelClient,
  ModelError,
  type ModelEvent,
  type ModelReply,
  type ModelRequest,
  type ModelUsage,
  type StopReason,
  zeroUsage,
} from '../../core/model.js';
import { RetryPolicy } from '../../core/retry.js';
import { TokenSource } from '../../core/token.js';
import { raise } from '../../core/usage.js';
import { sseReader } from './sse.js';
import type { Wire, WirePart } from './wire/wire.js';
import { wireFor } from './wires.js';

/** Everything the gateway resolved once, at layer build. */
interface Gateway extends HttpCaller {
  readonly catalog: ModelCatalogService;
}

/** One call, with the handle that stops it when the caller stops listening. */
interface Sent {
  readonly wire: Wire;
  readonly request: ModelRequest;
  readonly handle: AbortHandle | undefined;
}

/**
 * `request.stream` is already set by the caller; the wire reads it.
 *
 * Rendering is wrapped because a wire refuses what its shape cannot carry: an
 * image in a media type the provider does not take throws here, and that is a
 * failed call, not a crash.
 */
const bodyFor = (gateway: Gateway, sent: Sent) =>
  Effect.try({
    try: () => JSON.stringify(sent.wire.toBody(sent.request)),
    catch: cause => new ModelError({ reason: 'unsupported', cause }),
  }).pipe(
    Effect.flatMap(body =>
      post(gateway, { path: sent.wire.path, body, signal: sent.handle?.signal })
    )
  );

const send = (gateway: Gateway, request: ModelRequest): Effect.Effect<ModelReply, ModelError> =>
  withAbort(handle =>
    wireFor(gateway.catalog, request.model).pipe(
      Effect.flatMap(wire =>
        bodyFor(gateway, { wire, request: { ...request, stream: false }, handle }).pipe(
          Effect.flatMap(response =>
            Effect.tryPromise({
              try: () => response.text(),
              catch: cause => new ModelError({ reason: 'transport', cause }),
            })
          ),
          Effect.flatMap(text =>
            Effect.try({
              try: () => wire.toReply(JSON.parse(text)),
              catch: cause => new ModelError({ reason: 'body', cause }),
            })
          )
        )
      )
    )
  );

const chunksOf = (response: { readonly stream?: () => AsyncIterable<string> }) => {
  const body = response.stream;
  return body === undefined
    ? Stream.fail(new ModelError({ reason: 'transport', cause: 'the caller supplied no stream' }))
    : Stream.fromAsyncIterable(body(), cause => new ModelError({ reason: 'transport', cause }));
};

/** A wire part, as the caller sees it. The two shapes carry the same payloads. */
const asEvent = (part: WirePart): ModelEvent => {
  switch (part.kind) {
    case 'redacted': {
      return { kind: 'redacted', data: part.data };
    }
    case 'reasoning': {
      return part.signature === undefined
        ? { kind: 'reasoning', text: part.text }
        : { kind: 'reasoning', text: part.text, signature: part.signature };
    }
    case 'delta': {
      return { kind: 'delta', text: part.text };
    }
  }
};

/** What one stream collects on the way past, to report when it ends. */
interface Tally {
  readonly usage: Ref.Ref<ModelUsage>;
  readonly stop: Ref.Ref<StopReason>;
}

const eventsOf = (wire: Wire, tally: Tally, data: string) =>
  Effect.try({
    try: () => JSON.parse(data) as unknown,
    catch: cause => new ModelError({ reason: 'body', cause }),
  }).pipe(
    Effect.tap(event => {
      const part = wire.toUsage(event);
      return part === undefined ? Effect.void : Ref.update(tally.usage, held => raise(held, part));
    }),
    Effect.tap(event => {
      const reason = wire.toStop(event);
      return reason === undefined ? Effect.void : Ref.set(tally.stop, reason);
    }),
    Effect.map(event => Option.fromNullable(wire.toDelta(event)))
  );

/**
 * The handle lives as long as the stream, not as long as the request.
 *
 * A streamed call returns as soon as the headers arrive and keeps producing
 * afterwards, so a handle released when the request resolved would cancel
 * nothing. Scoped to the stream, dropping the stream stops the generation, and
 * the provider stops charging for it.
 */
const stream = (gateway: Gateway, request: ModelRequest): Stream.Stream<ModelEvent, ModelError> =>
  Stream.unwrapScoped(
    Effect.flatMap(
      Effect.acquireRelease(abortHandle(), handle => Effect.sync(() => handle?.abort())),
      handle => streamWith(gateway, request, handle)
    )
  );

const streamWith = (
  gateway: Gateway,
  request: ModelRequest,
  handle: AbortHandle | undefined
): Effect.Effect<Stream.Stream<ModelEvent, ModelError>> =>
  Effect.all({ usage: Ref.make(zeroUsage), stop: Ref.make<StopReason>('unknown') }).pipe(
    Effect.map(tally => {
      const read = sseReader();
      return Stream.unwrap(
        Effect.map(wireFor(gateway.catalog, request.model), wire =>
          Stream.fromEffect(
            bodyFor(gateway, { wire, request: { ...request, stream: true }, handle })
          ).pipe(
            Stream.flatMap(chunksOf),
            Stream.mapConcat(chunk => read(chunk)),
            Stream.mapEffect(data => eventsOf(wire, tally, data)),
            Stream.filterMap(part => part),
            Stream.map(asEvent),
            Stream.concat(
              Stream.fromEffect(
                Effect.all({ usage: Ref.get(tally.usage), stop: Ref.get(tally.stop) })
              ).pipe(
                Stream.map(
                  (ended): ModelEvent => ({ kind: 'done', usage: ended.usage, stop: ended.stop })
                )
              )
            )
          )
        )
      );
    })
  );

/**
 * The kilo gateway plugin. It picks the best shape the model speaks.
 *
 * The catalog, the token and the retry policy are resolved once here, so the
 * request path carries no lookup and the returned client needs no context.
 */
const layerKiloGateway = (
  config: HttpConfig
): Layer.Layer<ModelClient, never, ModelCatalog | TokenSource | RetryPolicy> =>
  Layer.effect(
    ModelClient,
    Effect.gen(function* () {
      const gateway: Gateway = {
        config,
        catalog: yield* ModelCatalog,
        token: yield* TokenSource,
        retry: yield* RetryPolicy,
      };
      return {
        send: request => send(gateway, request),
        stream: request => stream(gateway, request),
      };
    })
  );

export type { HttpConfig as KiloGatewayConfig };
export { layerKiloGateway };
