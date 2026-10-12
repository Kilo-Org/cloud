import { Effect, Stream } from 'effect';
import type { AbortLike, HttpResponse } from '../../core/fetch.js';
import {
  ModelError,
  type ModelEvent,
  type ModelUsage,
  type StopReason,
  zeroUsage,
} from '../../core/model.js';
import { raise } from '../../core/usage.js';
import { sseReader } from './sse.js';
import { isFailure, type Wire, type WirePart } from './wire/wire.js';
import { closed, indexedCall, type OpenCall } from './indexed-calls.js';

/**
 * Where a call gets the handle that cancels it.
 *
 * `AbortController` is a global in every runtime that has `fetch`, and this
 * package requires the caller to supply a `fetch`, so it is read off the global
 * rather than made into a plugin of its own. A runtime that lacks it still
 * works: the call simply cannot be stopped early.
 */
interface AbortHandle {
  readonly signal: AbortLike;
  readonly abort: () => void;
}

interface AbortHost {
  readonly AbortController?: new () => AbortHandle;
}

const host: AbortHost = globalThis;

/**
 * A handle for one call, released when the caller stops listening.
 *
 * The release aborts whether the call ended or was interrupted. Aborting a
 * request whose body has already been read does nothing, and the alternative is
 * inspecting the exit for a case where the answer is the same.
 */
const abortHandle = (): Effect.Effect<AbortHandle | undefined> =>
  Effect.sync(() => (host.AbortController === undefined ? undefined : new host.AbortController()));

const chunksOf = (
  response: { readonly stream?: () => AsyncIterable<string> },
  handle: AbortHandle | undefined
): Stream.Stream<string, ModelError> => {
  const body = response.stream;
  if (body === undefined) {
    return Stream.fail(
      new ModelError({ reason: 'transport', cause: 'the caller supplied no stream' })
    );
  }
  return Stream.unwrap(
    Effect.try({
      try: () => body()[Symbol.asyncIterator](),
      catch: cause => new ModelError({ reason: 'transport', cause }),
    }).pipe(
      Effect.map(iterator =>
        Stream.fromAsyncIterable(
          {
            [Symbol.asyncIterator]: () => ({
              next: () => iterator.next(),
              return: async () => {
                // Async-generator return waits for its pending read. Abort that
                // Read first, rather than waiting for the outer scope finalizer.
                handle?.abort();
                return iterator.return === undefined
                  ? { done: true, value: undefined }
                  : iterator.return();
              },
            }),
          },
          cause => new ModelError({ reason: 'transport', cause })
        )
      )
    )
  );
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
  /** Allocated only for providers that interleave calls. */
  indexed: Map<string, OpenCall> | undefined;
  /** Whether the model asked for anything. It decides the stop reason. */
  called: boolean;
}

/** Nothing to report from this frame. One value, so no frame allocates a list. */
const nothing: readonly ModelEvent[] = [];

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
  if (
    (part.kind === 'callStart' || part.kind === 'callArguments' || part.kind === 'callEnd') &&
    part.key !== undefined
  ) {
    return indexedCall(tally, part, part.key);
  }
  return collectSequential(tally, part);
};

const collectSequential = (tally: Tally, part: WirePart): readonly ModelEvent[] => {
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

const collectParts = (tally: Tally, parts: readonly WirePart[]): readonly ModelEvent[] => {
  const events: ModelEvent[] = [];
  for (const part of parts) {
    events.push(...collect(tally, part));
  }
  return events;
};

/** Everything one frame says: what it cost, why the model stopped, what it said. */
const read = (wire: Wire, tally: Tally, event: unknown): readonly ModelEvent[] => {
  const spent = wire.toUsage(event);
  if (spent !== undefined) {
    tally.usage = raise(tally.usage, spent);
  }
  tally.stop = wire.toStop(event) ?? tally.stop;
  const parts = wire.toParts?.(event);
  if (parts !== undefined) {
    return collectParts(tally, parts);
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
      (wire.isFailure?.(event) ?? isFailure(event))
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
    let ended = ending(tally);
    if (tally.indexed !== undefined) {
      const indexed = [...ended];
      for (const held of tally.indexed.values()) {
        indexed.push(...closed(held));
      }
      tally.indexed.clear();
      ended = indexed;
    }
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
const modelStream = (
  selected: Effect.Effect<Wire, ModelError>,
  send: (wire: Wire, handle: AbortHandle | undefined) => Effect.Effect<HttpResponse, ModelError>
): Stream.Stream<ModelEvent, ModelError> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const handle = yield* Effect.acquireRelease(abortHandle(), held =>
        Effect.sync(() => held?.abort())
      );
      const tally: Tally = {
        usage: zeroUsage,
        stop: 'unknown',
        open: undefined,
        indexed: undefined,
        called: false,
      };
      const wire = yield* selected;
      const frames = sseReader();

      return Stream.fromEffect(send(wire, handle)).pipe(
        Stream.flatMap(response => chunksOf(response, handle)),
        Stream.mapConcat(chunk => frames(chunk)),
        Stream.mapConcatEffect(data => eventsOf(wire, tally, data)),
        Stream.concat(lastOf(tally))
      );
    })
  );

export { modelStream };
export type { AbortHandle };
