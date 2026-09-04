import { Cause, Deferred, Duration, Effect, type Exit, Fiber, Option } from 'effect';
import { enqueue } from './queue.js';
import { type Tool, type ToolCall, type ToolFailure, type ToolResult, toolNamed } from './tool.js';
import { makeTurn, type PartDraft, type Turn } from './turn.js';
import { waited, waitFor, wanted, whileWaiting } from './waiting.js';
import type { Wiring } from './wiring.js';

/**
 * Runs the tools one turn asked for, and turns what they say into a turn.
 *
 * Nothing here fails. A tool that throws, a tool that does not exist, arguments
 * that are not JSON: each of those is a failed result handed back to the model,
 * which is the only party that can decide what to do about it. A session that
 * ended because a tool did not like its arguments would be a session that gives
 * up where a person would try again.
 *
 * The calls of one turn run at once. The model asks for several because they
 * are independent, and running them one after another spends the wall clock for
 * nothing. A tool that holds one thing says `concurrent: false` and the session
 * gives it a permit, so two calls to it queue while everything else overlaps.
 */

/** What the model is told when it names a tool the session does not offer. */
const noSuchTool = (name: string): string =>
  `There is no tool named ${name} in this session. Use one of the tools you were given.`;

const refusal = (call: ToolCall, body: string): ToolResult => ({
  callId: call.id,
  body,
  failed: true,
});

/**
 * What went wrong, in the words the model gets.
 *
 * A `ToolFailure` says it in its cause, which is what the tool's author wrote
 * for exactly this. Anything else is a defect, and the thrown value says as
 * much as there is to say. Neither is rendered with `Cause.pretty`: that
 * carries a stack trace, and a stack trace in a tool result is paid for on
 * every request of the session from then on.
 */
const reasonOf = (cause: Cause.Cause<ToolFailure>): string =>
  Option.match(Cause.failureOption(cause), {
    onSome: (failure: ToolFailure) => String(failure.cause),
    onNone: () => String(Cause.squash(cause)),
  });

/** What the model is told about a call it will hear about later. */
const stillRunning = (call: ToolCall): ToolResult => ({
  callId: call.id,
  body:
    'This call is still running. Its result will reach you in a later message. ' +
    'Carry on with whatever does not depend on it.',
  /* Not a failure. Nothing went wrong; the answer is simply not here yet, and a
     model told this had failed would start again rather than wait. */
  failed: false,
});

/**
 * The work itself, without the waiting.
 *
 * Interruption passes through rather than becoming a result: a session the
 * caller stopped has nobody left to tell, and a result written after the stream
 * was dropped would land in a transcript nobody asked for.
 */
const working = (wiring: Wiring, tool: Tool, call: ToolCall): Effect.Effect<ToolResult> => {
  const work: Effect.Effect<ToolResult> = tool.run(call).pipe(
    Effect.map((body): ToolResult => ({ callId: call.id, body, failed: false })),
    Effect.catchAllCause(cause =>
      Cause.isInterruptedOnly(cause)
        ? Effect.interrupt
        : Effect.succeed(refusal(call, reasonOf(cause)))
    )
  );
  const permit = wiring.locks.get(tool.definition.name);
  return permit === undefined ? work : permit.withPermits(1)(work);
};

/**
 * One call, run under a deadline it can outlive.
 *
 * Every call is forked, so the deadline moves the model on rather than
 * cancelling anything: the work keeps running in the session's own scope, and
 * what it eventually says goes on the queue that `background.ts` drains. That
 * is why any tool at all can be backgrounded — the harness decides when to stop
 * waiting, not the tool, and a tool that always outlives a request says
 * `inlineFor: 0` and is backgrounded from the start. Zero is read rather than
 * timed: a zero-length deadline raced against the work is a race the work
 * usually wins, and a tool that asked never to be waited for would be waited
 * for anyway.
 */
const under = (wiring: Wiring, tool: Tool, asked: ToolCall): Effect.Effect<ToolResult> =>
  Effect.gen(function* () {
    const { wait: wanting, call } = wanted(asked);
    const fiber = yield* Effect.forkIn(working(wiring, tool, call), wiring.scope);
    const release = yield* Deferred.make<boolean>();
    const wait = Duration.decode(waitFor(wiring, tool, wanting));
    const ended = yield* whileWaiting(wiring, { call, release }, waited(fiber, release, wait));
    return yield* Option.match(ended, {
      onSome: (exit: Exit.Exit<ToolResult>) => exit,
      onNone: () => later(wiring, call, fiber),
    });
  });

/**
 * How the answer reads to the model when it arrives out of turn.
 *
 * It goes back as words the conversation says, not as a second tool result: the
 * call it belongs to was already answered, and every shape refuses a second
 * result for one call.
 */
const lateText = (call: ToolCall, result: ToolResult): string =>
  `The ${call.name} call you made earlier (id ${call.id}) has ` +
  `${result.failed ? 'failed' : 'finished'}:\n\n${result.body}`;

/** Hands the model on, and puts what the call says in the line when it says it. */
const later = (
  wiring: Wiring,
  call: ToolCall,
  fiber: Fiber.RuntimeFiber<ToolResult>
): Effect.Effect<ToolResult> =>
  Effect.as(
    Effect.forkIn(
      Effect.flatMap(Fiber.join(fiber), result =>
        enqueue(wiring.pending, {
          kind: 'toolResult',
          parts: [{ kind: 'text', body: lateText(call, result) }],
        })
      ),
      wiring.scope
    ),
    stillRunning(call)
  );

/** One call, whatever it asked for. A name the session does not offer is a refusal. */
const runOne = (wiring: Wiring, call: ToolCall): Effect.Effect<ToolResult> =>
  Option.match(toolNamed(wiring.tools, call.name), {
    onNone: () => Effect.succeed(refusal(call, noSuchTool(call.name))),
    onSome: (tool: Tool) => under(wiring, tool, call),
  });

/** Every call of one turn, at once. The permits hold back what must not overlap. */
const runCalls = (
  wiring: Wiring,
  calls: readonly ToolCall[]
): Effect.Effect<readonly ToolResult[]> =>
  Effect.forEach(calls, call => runOne(wiring, call), { concurrency: 'unbounded' });

const partOf = (result: ToolResult): PartDraft => ({
  kind: 'toolResult',
  body: result.body,
  callId: result.callId,
  failed: result.failed,
});

/**
 * The results as one turn, in the order the model asked.
 *
 * The role is `user`, because a result is something the conversation tells the
 * model rather than something the model said. Every shape agrees on that, even
 * though each writes it differently.
 */
const resultsTurn = (wiring: Wiring, results: readonly ToolResult[]): Effect.Effect<Turn> =>
  makeTurn(wiring.entropy, {
    sessionId: wiring.id,
    role: 'user',
    parts: results.map(partOf),
  });

/** The calls in a turn, in order, ready to run. */
const callsIn = (turn: Turn): readonly ToolCall[] =>
  turn.parts
    .filter(part => part.kind === 'toolCall')
    .map(part => ({ id: part.callId, name: part.name, arguments: part.body }));

export { callsIn, resultsTurn, runCalls };
