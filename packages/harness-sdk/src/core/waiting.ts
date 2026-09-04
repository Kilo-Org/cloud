import { Clock, Deferred, Duration, Effect, type Exit, Fiber, Option, Ref } from 'effect';
import { type Tool, type ToolCall, type ToolResult, waitField } from './tool.js';
import type { Running, Wiring } from './wiring.js';

/**
 * How long the model waits for one call, and who gets to decide.
 *
 * Four parties have a say, and the most specific one wins. The tool author
 * names a default with `inlineFor`, because a tool that always outlives a
 * request knows that about itself. The session names a fallback. The model
 * itself answers `wait` on the call, in either direction. And a caller watching
 * a call that is already running can stop the waiting at any moment.
 *
 * None of them changes what the tool does. Every call is forked into the
 * session's scope and runs to the end whatever is decided here: what is under
 * discussion is only whether the model sits and waits for it, or is handed a
 * note and told the answer later.
 */

/**
 * How long the model waits before a call goes to the background. Half a minute
 * is long enough for anything that reads a file or asks a server, and short
 * enough that a request is not left open on something slower.
 */
const defaultInlineFor = Duration.seconds(30);

/**
 * What the model asked for about waiting, and the call without it.
 *
 * The field is the harness's, so the tool never sees it: a tool that validates
 * its own arguments strictly would refuse a key it does not know, and a tool
 * author should not have to know this exists. Arguments that are not an object
 * pass through untouched — malformed JSON is the tool's to complain about, and
 * a runner that rewrote it would change the words of the complaint.
 */
const wanted = (call: ToolCall): { readonly wait?: boolean; readonly call: ToolCall } => {
  const held: unknown = tried(() => JSON.parse(call.arguments));
  if (!isFields(held)) {
    return { call };
  }
  const { [waitField]: wait, ...rest } = held;
  if (typeof wait !== 'boolean') {
    return { call };
  }
  return { wait, call: { ...call, arguments: JSON.stringify(rest) } };
};

/** Arguments the field can be taken out of: a JSON object and nothing else. */
const isFields = (held: unknown): held is Record<string, unknown> =>
  typeof held === 'object' && held !== null && !Array.isArray(held);

/** `undefined` rather than a throw, so a malformed call reaches its own tool. */
const tried = (parse: () => unknown): unknown => {
  try {
    return parse();
  } catch {
    return undefined;
  }
};

/**
 * How long the model waits for one call.
 *
 * The model's own answer wins where it gave one, in both directions: it may
 * give up on a call the tool expected it to wait for, and it may wait for one
 * the tool expected it to abandon. Neither costs anything at the provider —
 * tools run between requests, not during one — so what waiting spends is the
 * caller's own stream, and the caller can cut that short at any time with
 * `session.background`.
 *
 * A model that waits still waits under a limit: the session's, or the
 * package's, never the tool's zero and never forever.
 */
const waitFor = (wiring: Wiring, tool: Tool, wait?: boolean): Duration.DurationInput => {
  if (wait === false) {
    return Duration.zero;
  }
  return wait === true
    ? (wiring.inlineFor ?? defaultInlineFor)
    : (tool.inlineFor ?? wiring.inlineFor ?? defaultInlineFor);
};

/** One call the model is waiting on, as a caller reads it. */
interface RunningCall {
  readonly id: string;
  readonly name: string;
  readonly since: number;
}

const shown = (one: Running): RunningCall => ({
  id: one.call.id,
  name: one.call.name,
  since: one.since,
});

/** What the model is waiting on now, in the order the calls started. */
const runningIn = (wiring: Wiring): Effect.Effect<readonly RunningCall[]> =>
  Effect.map(Ref.get(wiring.running), held =>
    [...held.values()].map(shown).sort((one, other) => one.since - other.since)
  );

/**
 * Stops the model waiting for one call, now. True when it was still waiting.
 *
 * False means the call has already been answered, has already gone to the
 * background, or was never here. None of those is an error: a person pressing
 * the key as the answer lands is ordinary.
 *
 * The same call serves a person and an agent. Which of them decided is the
 * caller's business, and the session does not need to know.
 */
const backgroundNow = (wiring: Wiring, callId: string): Effect.Effect<boolean> =>
  Effect.flatMap(Ref.get(wiring.running), held => {
    const one = held.get(callId);
    /* `Deferred.succeed` answers false when it was already completed, which is
       a call somebody sent away twice. Both facts read the same to a caller:
       it is no longer waiting on this one. */
    return one === undefined ? Effect.succeed(false) : Deferred.succeed(one.release, true);
  });

/** Holds the call in `running` for as long as the model is waiting on it. */
const whileWaiting = <A>(
  wiring: Wiring,
  one: Omit<Running, 'since'>,
  wait: Effect.Effect<A>
): Effect.Effect<A> =>
  Effect.acquireUseRelease(
    Effect.flatMap(Clock.currentTimeMillis, since =>
      Ref.update(wiring.running, held => new Map(held).set(one.call.id, { ...one, since }))
    ),
    () => wait,
    () =>
      Ref.update(wiring.running, held => {
        const left = new Map(held);
        left.delete(one.call.id);
        return left;
      })
  );

/**
 * Waits for the call, unless the deadline passes or somebody sends it away.
 *
 * `None` means the model stops waiting: the answer is not here, and the call
 * carries on without it.
 */
const waited = (
  fiber: Fiber.RuntimeFiber<ToolResult>,
  release: Deferred.Deferred<boolean>,
  wait: Duration.Duration
): Effect.Effect<Option.Option<Exit.Exit<ToolResult>>> =>
  Duration.isZero(wait)
    ? Effect.succeed(Option.none())
    : Effect.map(
        Effect.timeoutOption(
          Effect.raceFirst(
            Effect.map(
              Fiber.await(fiber),
              (exit): Option.Option<Exit.Exit<ToolResult>> => Option.some(exit)
            ),
            Effect.as(Deferred.await(release), Option.none<Exit.Exit<ToolResult>>())
          ),
          wait
        ),
        Option.flatten
      );

export type { RunningCall };
export { backgroundNow, defaultInlineFor, runningIn, waited, waitFor, wanted, whileWaiting };
