import { Effect, Layer, Stream } from 'effect';
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
      post(gateway, {
        path: sent.wire.path,
        body,
        session: sent.request.cacheKey,
        signal: sent.handle?.signal,
      })
    )
  );

const chunksOf = (response: { readonly stream?: () => AsyncIterable<string> }) => {
  const body = response.stream;
  return body === undefined
    ? Stream.fail(new ModelError({ reason: 'transport', cause: 'the caller supplied no stream' }))
    : Stream.fromAsyncIterable(body(), cause => new ModelError({ reason: 'transport', cause }));
};

/**
 * What one stream collects on the way past, to report when it ends.
 *
 * It is mutable, and that is the one place in this package where mutation is
 * the right answer. One of these is made per call, inside `stream` below, and
 * never leaves it: a `Stream` is consumed by one fiber, so nothing else can see
 * a half-written tally and no `Ref` is buying anything.
 *
 * What it buys instead is measured. This path runs once per streamed event, and
 * before this it was five Effect operators over four `Ref`s per event, which is
 * an allocation each on the one path a long answer walks thousands of times.
 * See "What a streamed token actually costs" in AGENTS.md.
 */
interface Tally {
  usage: ModelUsage;
  stop: StopReason;
  /** The call being read, until the frame that closes it. See `collect`. */
  open: OpenCall | undefined;
  /** Whether the model asked for anything. It decides the stop reason. */
  called: boolean;
}

/** A tool call as it arrives: the name first, then the arguments in fragments. */
interface OpenCall {
  readonly id: string;
  readonly name: string;
  /** Grown a fragment at a time, in place: a copy per fragment is quadratic. */
  text: string;
}

/** Nothing to report from this frame. One value, so no frame allocates a list. */
const nothing: readonly ModelEvent[] = [];

const closed = (held: OpenCall | undefined): readonly ModelEvent[] =>
  held === undefined
    ? nothing
    : [{ kind: 'toolCall', call: { id: held.id, name: held.name, arguments: held.text } }];

/** Closes whatever call is open, and leaves nothing open behind it. */
const ending = (tally: Tally): readonly ModelEvent[] => {
  const held = tally.open;
  tally.open = undefined;
  return closed(held);
};

/**
 * Collects the pieces of a tool call into one event, and passes everything else
 * through untouched.
 *
 * A call closes on the frame that says so, and on the frame that opens the next
 * one: one shape sends no closing frame at all, so opening a second call is
 * what ends the first. What is still open when the stream ends is closed by
 * `lastOf`.
 */
const collect = (tally: Tally, part: WirePart): readonly ModelEvent[] => {
  switch (part.kind) {
    case 'callStart': {
      const ended = ending(tally);
      tally.open = { id: part.id, name: part.name, text: part.text ?? '' };
      tally.called = true;
      return ended;
    }
    case 'callArguments': {
      if (tally.open !== undefined) {
        tally.open.text += part.text;
      }
      return nothing;
    }
    case 'callEnd': {
      return ending(tally);
    }
    case 'delta':
    case 'reasoning':
    case 'redacted': {
      return [part];
    }
  }
};

/** Everything one frame says: what it cost, why the model stopped, what it said. */
const read = (wire: Wire, tally: Tally, event: unknown): readonly ModelEvent[] => {
  const spent = wire.toUsage(event);
  if (spent !== undefined) {
    tally.usage = raise(tally.usage, spent);
  }
  const reason = wire.toStop(event);
  if (reason !== undefined) {
    tally.stop = reason;
  }
  const part = wire.toDelta(event);
  return part === undefined ? nothing : collect(tally, part);
};

/**
 * One frame, as the stream sees it. Two operators where there were five, and
 * the Effect stays because a body that will not parse and a failure the
 * provider reported mid-answer are both the end of the call and have to fail
 * it. What was worth removing was the four `Ref`s, not this.
 */
const eventsOf = (
  wire: Wire,
  tally: Tally,
  data: string
): Effect.Effect<readonly ModelEvent[], ModelError> =>
  Effect.try({
    try: (): unknown => JSON.parse(data),
    catch: cause => new ModelError({ reason: 'body', cause }),
  }).pipe(
    Effect.flatMap(event =>
      isFailure(event)
        ? Effect.fail(new ModelError({ reason: 'stream', cause: event }))
        : Effect.succeed(read(wire, tally, event))
    )
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

/**
 * The last events of every stream: the call still open, the cost, and the
 * reason. Suspended, because this is built when the stream is and read when the
 * stream ends.
 */
const lastOf = (tally: Tally): Stream.Stream<ModelEvent> =>
  Stream.suspend(() => {
    const ended = ending(tally);
    const done: ModelEvent = {
      kind: 'done',
      usage: tally.usage,
      stop: reasonOf(tally.stop, tally.called),
    };
    return Stream.fromIterable([...ended, done]);
  });

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
        usage: zeroUsage,
        stop: 'unknown',
        open: undefined,
        called: false,
      };
      const wire = yield* wireFor(gateway.catalog, request.model);
      const frames = sseReader();

      return Stream.fromEffect(bodyFor(gateway, { wire, request, handle })).pipe(
        Stream.flatMap(chunksOf),
        Stream.mapConcat(chunk => frames(chunk)),
        Stream.mapConcatEffect(data => eventsOf(wire, tally, data)),
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
