import { Effect, Layer, Option, Ref, Stream } from 'effect';
import { abortHandle, post, type AbortHandle, type HttpCaller, type HttpConfig } from './http.js';
import { ModelCatalog, type ModelCatalogService } from '../../core/catalog.js';
import {
  ModelClient,
  ModelError,
  type ModelEvent,
  type ModelRequest,
  type ModelUsage,
  type StopReason,
  zeroUsage,
} from '../../core/model.js';
import { RetryPolicy } from '../../core/retry.js';
import { TokenSource } from '../../core/token.js';
import { raise } from '../../core/usage.js';
import { sseReader } from './sse.js';
import { isFailure, type Wire, type WirePart } from './wire/wire.js';
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

const chunksOf = (response: { readonly stream?: () => AsyncIterable<string> }) => {
  const body = response.stream;
  return body === undefined
    ? Stream.fail(new ModelError({ reason: 'transport', cause: 'the caller supplied no stream' }))
    : Stream.fromAsyncIterable(body(), cause => new ModelError({ reason: 'transport', cause }));
};

/** What one stream collects on the way past, to report when it ends. */
interface Tally {
  readonly usage: Ref.Ref<ModelUsage>;
  readonly stop: Ref.Ref<StopReason>;
  /** The call being read, until the frame that closes it. See `collect`. */
  readonly open: Ref.Ref<Option.Option<OpenCall>>;
  /** Whether the model asked for anything. It decides the stop reason. */
  readonly called: Ref.Ref<boolean>;
}

/** A tool call as it arrives: the name first, then the arguments in fragments. */
interface OpenCall {
  readonly id: string;
  readonly name: string;
  readonly text: string;
}

/** Nothing to report from this frame. One value, so no frame allocates a list. */
const nothing: readonly ModelEvent[] = [];

const closed = (held: Option.Option<OpenCall>): readonly ModelEvent[] =>
  Option.match(held, {
    onNone: () => nothing,
    onSome: (call): readonly ModelEvent[] => [
      { kind: 'toolCall', call: { id: call.id, name: call.name, arguments: call.text } },
    ],
  });

/**
 * Collects the pieces of a tool call into one event, and passes everything else
 * through untouched.
 *
 * A call closes on the frame that says so, and on the frame that opens the next
 * one: one shape sends no closing frame at all, so opening a second call is
 * what ends the first. What is still open when the stream ends is closed by
 * `lastOf`.
 */
const collect = (tally: Tally, part: WirePart): Effect.Effect<readonly ModelEvent[]> => {
  switch (part.kind) {
    case 'callStart': {
      const opened: OpenCall = { id: part.id, name: part.name, text: part.text ?? '' };
      return Ref.getAndSet(tally.open, Option.some(opened)).pipe(
        Effect.zipLeft(Ref.set(tally.called, true)),
        Effect.map(closed)
      );
    }
    case 'callArguments': {
      const grow = Option.map((held: OpenCall) => ({ ...held, text: held.text + part.text }));
      return Effect.as(Ref.update(tally.open, grow), nothing);
    }
    case 'callEnd': {
      return Effect.map(Ref.getAndSet(tally.open, Option.none()), closed);
    }
    case 'delta':
    case 'reasoning':
    case 'redacted': {
      return Effect.succeed([part]);
    }
  }
};

const eventsOf = (wire: Wire, tally: Tally, data: string) =>
  Effect.try({
    try: () => JSON.parse(data) as unknown,
    catch: cause => new ModelError({ reason: 'body', cause }),
  }).pipe(
    Effect.filterOrFail(
      event => !isFailure(event),
      event => new ModelError({ reason: 'stream', cause: event })
    ),
    Effect.tap(event => {
      const part = wire.toUsage(event);
      return part === undefined ? Effect.void : Ref.update(tally.usage, held => raise(held, part));
    }),
    Effect.tap(event => {
      const reason = wire.toStop(event);
      return reason === undefined ? Effect.void : Ref.set(tally.stop, reason);
    }),
    Effect.flatMap(event => {
      const part = wire.toDelta(event);
      return part === undefined ? Effect.succeed(nothing) : collect(tally, part);
    })
  );

/**
 * Why the model really stopped.
 *
 * One shape names the reason outright. The other two report a finished response
 * whether or not the model asked for a tool, so a stream that produced a call
 * says so here instead. Only a clean end is corrected: an answer the ceiling cut
 * off holds half a call, and running it would run something the model did not
 * finish asking for.
 */
const reasonOf = (stop: StopReason, called: boolean): StopReason =>
  called && stop === 'end' ? 'tools' : stop;

/** The last events of every stream: the call still open, the cost, and the reason. */
const lastOf = (tally: Tally): Stream.Stream<ModelEvent> =>
  Stream.fromIterableEffect(Effect.map(Ref.getAndSet(tally.open, Option.none()), closed)).pipe(
    Stream.concat(
      Stream.fromEffect(
        Effect.all({
          usage: Ref.get(tally.usage),
          stop: Ref.get(tally.stop),
          called: Ref.get(tally.called),
        })
      ).pipe(
        Stream.map(
          (ended): ModelEvent => ({
            kind: 'done',
            usage: ended.usage,
            stop: reasonOf(ended.stop, ended.called),
          })
        )
      )
    )
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
    Effect.gen(function* () {
      const handle = yield* Effect.acquireRelease(abortHandle(), held =>
        Effect.sync(() => held?.abort())
      );
      const tally: Tally = {
        usage: yield* Ref.make(zeroUsage),
        stop: yield* Ref.make<StopReason>('unknown'),
        open: yield* Ref.make(Option.none<OpenCall>()),
        called: yield* Ref.make(false),
      };
      const wire = yield* wireFor(gateway.catalog, request.model);
      const read = sseReader();

      return Stream.fromEffect(bodyFor(gateway, { wire, request, handle })).pipe(
        Stream.flatMap(chunksOf),
        Stream.mapConcat(chunk => read(chunk)),
        Stream.mapEffect(data => eventsOf(wire, tally, data)),
        Stream.flattenIterables,
        Stream.concat(lastOf(tally))
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
        stream: request => stream(gateway, request),
      };
    })
  );

export type { HttpConfig as KiloGatewayConfig };
export { layerKiloGateway };
