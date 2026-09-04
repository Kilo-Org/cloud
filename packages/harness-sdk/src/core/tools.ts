import { Cause, Effect, Option } from 'effect';
import { type Tool, type ToolCall, type ToolFailure, type ToolResult, toolNamed } from './tool.js';
import { makeTurn, type PartDraft, type Turn } from './turn.js';
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

/**
 * One call, under its permit when it has one.
 *
 * Interruption passes through rather than becoming a result: a session the
 * caller stopped has nobody left to tell, and a result written after the stream
 * was dropped would land in a transcript nobody asked for.
 */
const under = (wiring: Wiring, tool: Tool, call: ToolCall): Effect.Effect<ToolResult> => {
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
const resultsTurn = (
  wiring: Wiring,
  results: readonly ToolResult[]
): Effect.Effect<Turn> =>
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
