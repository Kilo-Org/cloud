import { type Duration, Effect, type Layer, type Scope, Stream } from 'effect';
import { createAssert } from 'typia';
import type { Effort, ModelUsage } from '../../core/model.js';
import { openSession } from '../../core/run.js';
import { type JsonSchema, type Tool, ToolFailure, type ToolCall } from '../../core/tool.js';
import type { SessionContext } from '../../core/wiring.js';

/**
 * A tool that is a session of its own.
 *
 * The model asks for one thing in one sentence, and something else goes and
 * does it: its own system prompt, its own model, its own tools, and a
 * transcript the parent never sees. What comes back is one answer, so the
 * parent pays for the answer rather than for every step that produced it. That
 * is the whole point of a subagent — a long search, a file read three ways, a
 * draft rewritten twice, all of it kept out of a conversation that has to stay
 * cheap to replay.
 *
 * Nothing here is new machinery. A subagent is `openSession` called from inside
 * a tool, which is why it takes the layers it should run under: a tool is
 * handed no context, so whatever the session needs must be given to the tool
 * when it is built. The layers may be the parent's own or another set entirely,
 * which is how a subagent runs on a cheaper model than the one that called it.
 *
 * What reaches the parent is one string, and what it says on the way to its own
 * tools is not part of it: a model narrates before it calls something, and
 * handing that up would put back the noise a subagent exists to absorb.
 *
 * The store is the one thing that is shared, and it is shared on purpose. A
 * session reads `SessionStore` from whatever context it runs in, and a tool runs
 * inside the parent's, so a subagent writes to the same database — under a
 * session of its own. One database, two transcripts, neither poisoning the
 * other. Pass layers with a store of their own to separate even that.
 *
 * What reaches the parent's `usage` is nothing, because the counts belong to
 * the session that spent them. `onFinished` hands them over for a caller that
 * is adding up what a conversation cost.
 *
 * It is a tool like any other, so the session's deadline applies to it and a
 * caller can send a running one to the background. A subagent is usually the
 * longest call in a harness, so that matters more here than anywhere else.
 */

/** What the subagent was asked to do. Anything else is a failed result. */
interface Asked {
  readonly task: string;
}

const assertAsked = createAssert<Asked>();

/** Everything the subagent's session is opened with, and who to tell about it. */
interface SubagentOptions {
  /** The subagent's own system prompt. It never sees the parent's. */
  readonly system: string;
  readonly model: string;
  /** The name the model calls it by. `subagent` unless a harness has its own. */
  readonly name?: string;
  /** What the model reads about it. Say what it is for, in the harness's words. */
  readonly description?: string;
  /**
   * The tools the subagent may use, by name, out of the registry in its layers.
   * A subagent offered the tool that starts it can start one of its own, and
   * nothing here stops that: how deep is the harness's decision, not this
   * package's.
   */
  readonly tools?: readonly string[];
  readonly maxTokens?: number;
  readonly effort?: Effort;
  /**
   * How long the parent's model waits before the call goes to the background.
   * A subagent that reads or searches usually outlives a request, so this is
   * worth setting where a harness knows.
   */
  readonly inlineFor?: Duration.DurationInput;
  /**
   * Whether the model waits for the subagent, as it is told by default. False,
   * because handing a task over is how a model carries on. A harness whose
   * subagents are quick, or whose parent has nothing else to do, says true.
   */
  readonly wait?: boolean;
  /**
   * Told what one subagent cost and where its transcript is, once it has
   * answered. This is the only thing that crosses back: a caller adding up what
   * a conversation spent needs the subagent's counts, and the parent session
   * cannot see them.
   */
  readonly onFinished?: (report: SubagentReport) => Effect.Effect<void>;
}

/** What one subagent did, for the caller that is counting. */
interface SubagentReport {
  /** The subagent's own session, which is where its turns are stored. */
  readonly sessionId: string;
  readonly usage: ModelUsage;
  readonly said: string;
}

/** Everything a subagent session needs, less the scope the tool opens itself. */
type SubagentContext = Exclude<SessionContext, Scope.Scope>;

const parameters: JsonSchema = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description:
        'What to do, in full. The subagent starts fresh and knows nothing ' +
        'about this conversation, so say everything it needs in this one ' +
        'sentence, and say what you want back.',
    },
  },
  required: ['task'],
  additionalProperties: false,
};

/**
 * Three sentences, two of which `e2e/tool-matrix.ts` bought.
 *
 * The first version named two uses — work of several steps, work that produces
 * more reading than you need — and two of eleven models read those as the only
 * two. Asked one thing they could not know, they answered that no tool of
 * theirs could look it up and asked the person for a source. That is the right
 * move if a subagent is only for long work, so the uses became a list to lead
 * with rather than a gate, and the first one is what those two needed:
 * something you cannot answer yourself. It moved one of them.
 *
 * The one left doubted the subagent could reach anything it could not, so the
 * second sentence says what a subagent is: a session started from instructions
 * of its own. That is true of every subagent, including one given no tools at
 * all, which is why it can be said here rather than by the harness.
 */
const description =
  'Hands one task to a subagent, which goes and does it in a conversation of ' +
  'its own and answers with the result. It starts from instructions of its own, ' +
  'so it can reach what this conversation cannot. Use it for anything you ' +
  'cannot answer from what you already know: something to look up, somewhere to ' +
  'search, work that takes several steps, or work that produces more reading ' +
  'than you need to keep. It remembers nothing between calls and cannot ask you ' +
  'anything, so give it everything at once and say what you want back.';

/** What the model sent, or a failed result saying what was wrong with it. */
const asked = (call: ToolCall): Effect.Effect<Asked, ToolFailure> =>
  Effect.try({
    try: () => assertAsked(JSON.parse(call.arguments)),
    catch: cause => new ToolFailure({ cause }),
  });

/** The subagent's own session, run to the end of one answer. */
const answering = (
  options: SubagentOptions,
  task: string
): Effect.Effect<SubagentReport, unknown, SubagentContext | Scope.Scope> =>
  Effect.gen(function* () {
    const session = yield* openSession({
      system: options.system,
      model: options.model,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    });
    const said = yield* Stream.runFold(session.ask(task), '', (held: string, event) => {
      if (event.kind === 'delta') {
        return held + event.text;
      }
      /* What the subagent said on the way to a tool is not its answer. A model
         narrates before it calls something — "let me look" — and handing that
         up would put the noise a subagent exists to absorb back into the
         parent's transcript. The answer is what it said after its last call. */
      return event.kind === 'done' && event.stop === 'tools' ? '' : held;
    });
    return { sessionId: session.id, usage: yield* session.usage, said };
  });

/** Tells whoever is counting, and hands the model the answer. */
const finish = (options: SubagentOptions, report: SubagentReport): Effect.Effect<string> =>
  Effect.as(options.onFinished?.(report) ?? Effect.void, report.said);

/**
 * The tool, given what the subagent is and the layers it runs under.
 *
 * A failure inside the subagent is a failed result and not a failed session:
 * the parent model reads what went wrong and decides whether to ask again, ask
 * differently, or carry on without it.
 */
const subagentTool = <E>(
  options: SubagentOptions,
  /**
   * A layer that fails is a failed result like any other: the harness that
   * built it hears about it through the model, which is the only party that can
   * decide what to do without one.
   */
  layers: Layer.Layer<SubagentContext, E>
): Tool => ({
  definition: {
    name: options.name ?? 'subagent',
    description: options.description ?? description,
    parameters,
  },
  /* Handing a task over is how the model carries on, so it does not wait for
     one by default. A model that has nothing to do until the task is done says
     so on the call. */
  wait: options.wait ?? false,
  ...(options.inlineFor === undefined ? {} : { inlineFor: options.inlineFor }),
  run: (call: ToolCall) =>
    Effect.flatMap(asked(call), ({ task }) =>
      Effect.scoped(Effect.provide(answering(options, task), layers)).pipe(
        Effect.mapError(cause =>
          cause instanceof ToolFailure ? cause : new ToolFailure({ cause })
        ),
        Effect.flatMap(report => finish(options, report))
      )
    ),
});

export type { SubagentContext, SubagentOptions, SubagentReport };
export { subagentTool };
