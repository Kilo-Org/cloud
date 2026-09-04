import { Context, Data, Duration, Effect, Option } from 'effect';

/**
 * A tool is something the model may ask for, and the code that answers.
 *
 * The package splits a tool in two, and the split is not cosmetic. What the
 * model is told — the name, the description, the schema — sits in front of
 * every message of every request, so it is part of the cached prefix and is
 * frozen for the life of a session, exactly as the system prompt is. What the
 * tool does is a plugin, resolved when the session opens.
 *
 * A session names the tools it offers, in order, and the order is part of the
 * prefix too. The definitions come from the registry rather than from the
 * store: a definition lives in code and ships with the build, where a system
 * prompt is a value a caller made at run time. See AGENTS.md, "A session names
 * its tools; the registry defines them".
 */

/**
 * The JSON Schema of a tool's arguments. Every shape takes one, under a name of
 * its own, and none of them looks inside it.
 *
 * It is stated rather than left as `unknown` so a tool this package ships is
 * checked when it is written. It is not validated at run time: a definition is
 * a caller's own value, not an edge. See AGENTS.md, principle 10.
 */
interface JsonSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

/** What the model is told a tool is. Frozen: it sits in the cached prefix. */
interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

/**
 * What the model asked for.
 *
 * `arguments` is the JSON text the model wrote, not a parsed object. It is text
 * because that is how every shape streams it, because the tool is the only
 * thing that knows what shape it should be, and because a model that writes
 * malformed JSON must be told so rather than crash the session.
 */
interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** What goes back to the model, against the call it answers. */
interface ToolResult {
  readonly callId: string;
  readonly body: string;
  /** True when the tool did not do what it was asked. The model reads it and retries. */
  readonly failed: boolean;
}

/**
 * A tool did not do what it was asked.
 *
 * This is not a failed session. The runner turns it into a failed result and
 * hands it to the model, which is the only party that can decide what to do
 * about it. Nothing a tool does fails the stream.
 */
class ToolFailure extends Data.TaggedError('harness/ToolFailure')<{
  readonly cause: unknown;
}> {}

/** A session named a tool that the registry does not hold. */
class ToolMissingError extends Data.TaggedError('harness/ToolMissingError')<{
  readonly tool: string;
}> {}

/**
 * A tool, as the registry holds it.
 *
 * `run` takes no context: a tool comes from a layer, so whatever it needs was
 * provided when that layer was built.
 */
interface Tool {
  readonly definition: ToolDefinition;
  /**
   * How long the model waits for this tool before the call goes to the
   * background. The session's own limit applies when this names none.
   *
   * Zero backgrounds every call to it at once, which is what a tool that waits
   * on a person wants: no model should sit on an open request while somebody
   * reads a question.
   *
   * It bounds the waiting; it does not decide whether there is any. `wait`
   * decides that, and the model's own answer beats both.
   */
  readonly inlineFor?: Duration.DurationInput;
  /**
   * Whether the model waits for this tool, as the model is told by default.
   *
   * The tool knows something the harness cannot. A question the model asked
   * because it cannot go on without the answer is worth waiting for, so
   * `question` says true. A subagent the model handed a task to is not: the
   * whole point of handing it over is to carry on, so `subagent` says false.
   *
   * It reaches the model as the schema's `default`, so a model that says
   * nothing gets what the tool expects and a model that knows better overrides
   * it. Without it the default is read from `inlineFor`: a tool that waits no
   * time at all advertises false, and everything else advertises true.
   */
  readonly wait?: boolean;
  /**
   * Whether two calls to this tool may overlap. True by default, because the
   * model asks for several at once and running them one after another wastes
   * the wall clock. A tool that holds one thing — a working directory, a file
   * it rewrites, a socket — sets this false and the runner serialises it.
   */
  readonly concurrent?: boolean;
  readonly run: (call: ToolCall) => Effect.Effect<string, ToolFailure>;
}

/**
 * Every tool a session may be opened with. It is one service and not one per
 * tool, because a caller assembles the set once and the session picks from it
 * by name.
 */
interface ToolRegistryService {
  readonly tools: readonly Tool[];
}

class ToolRegistry extends Context.Tag('harness/ToolRegistry')<
  ToolRegistry,
  ToolRegistryService
>() {}

/** The tool of that name, or nothing. */
const toolNamed = (tools: readonly Tool[], name: string): Option.Option<Tool> =>
  Option.fromNullable(tools.find(tool => tool.definition.name === name));

/**
 * The name of the field the model sets to choose whether it waits.
 *
 * It is the harness's field and not the tool's: every tool carries it, no tool
 * author writes it, and the runner takes it off again before the tool ever sees
 * the arguments.
 */
const waitField = 'wait';

/**
 * How long the model waits for a tool that names no deadline of its own, and
 * whose session names none either. Half a minute is long enough for anything
 * that reads a file or asks a server, and short enough that a request is not
 * left open on something slower.
 */
const defaultInlineFor = Duration.seconds(30);

const waitProperty = {
  type: 'boolean',
  description:
    'Whether to wait for this call. False hands you a note saying it is ' +
    'still running, so you can carry on with what does not depend on it, and ' +
    'the result reaches you in a later message. True waits for it. The default ' +
    'is what this tool expects — leave it out unless this call is different.',
};

/**
 * Whether the model waits for this tool when it says nothing.
 *
 * The tool's own answer if it gave one. Otherwise it is read from the deadline:
 * a tool that waits no time at all is a tool nobody waits for.
 */
const waitsFor = (tool: Tool, session?: Duration.DurationInput): boolean =>
  tool.wait ?? !Duration.isZero(Duration.decode(tool.inlineFor ?? session ?? defaultInlineFor));

/** One tool as the model is told it, with the field the harness adds to all of them. */
const asOffered = (tool: Tool, session?: Duration.DurationInput): ToolDefinition => ({
  ...tool.definition,
  parameters: {
    ...tool.definition.parameters,
    properties: {
      ...tool.definition.parameters.properties,
      [waitField]: { ...waitProperty, default: waitsFor(tool, session) },
    },
  },
});

/**
 * What the model is told about the tools, in the order the session named them.
 *
 * Every one of them gains `wait`, because whether the model waits for a call is
 * the model's decision to make and not the tool author's. What the tool author
 * decided reaches the model as that field's default, so a model that says
 * nothing gets it.
 */
const definitionsOf = (
  tools: readonly Tool[],
  session?: Duration.DurationInput
): readonly ToolDefinition[] => tools.map(tool => asOffered(tool, session));

/**
 * Resolves the names a session was opened with, in that order, against the
 * registry. A name nothing holds fails here, when the session opens, rather
 * than at the first question that happens to want it.
 *
 * A session that names no tool never asks for the registry, so a caller with no
 * tools needs no layer for them.
 */
const resolveTools = (names: readonly string[]): Effect.Effect<readonly Tool[], ToolMissingError> =>
  names.length === 0
    ? Effect.succeed([])
    : Effect.flatMap(Effect.serviceOption(ToolRegistry), registry =>
        Effect.forEach(names, name =>
          Option.match(
            Option.flatMap(registry, held => toolNamed(held.tools, name)),
            {
              onNone: () => Effect.fail(new ToolMissingError({ tool: name })),
              onSome: (tool: Tool) => Effect.succeed(tool),
            }
          )
        )
      );

/**
 * The one permit a tool that refuses to overlap holds, kept with the tool.
 *
 * **It belongs to the tool object and not to a session**, and that is the whole
 * point. A permit is only a lock against whoever holds the same permit, so a
 * permit made per session locks nothing between two sessions. A harness builds
 * `questionTool(ask)` once, puts it in one registry, and gives that registry to
 * a parent and to its subagents; each session used to make a permit of its own,
 * so the parent and the subagent could both call the asker and put two dialogs
 * on one person at once — which is exactly what `concurrent: false` says must
 * not happen. What the flag protects is the thing the tool holds, and the thing
 * the tool holds outlives any one session.
 *
 * Two tools built separately do not share, and should not: `questionTool(askA)`
 * and `questionTool(askB)` are two askers, two things to protect, two permits.
 *
 * The map is weak, so a permit lives exactly as long as the tool it belongs to.
 * `unsafeMakeSemaphore` is the permit itself rather than an effect that makes
 * one — "unsafe" here means unwrapped, not risky; it allocates a counter.
 *
 * A tool that allows overlap never gets an entry, so the usual path costs one
 * miss on a weak map and nothing else.
 */
const permits = new WeakMap<Tool, Effect.Semaphore>();

const lockFor = (tool: Tool): Effect.Semaphore | undefined => {
  if (tool.concurrent !== false) {
    return undefined;
  }
  const held = permits.get(tool);
  if (held !== undefined) {
    return held;
  }
  const made = Effect.unsafeMakeSemaphore(1);
  permits.set(tool, made);
  return made;
};

export type { JsonSchema, Tool, ToolCall, ToolDefinition, ToolRegistryService, ToolResult };
export {
  asOffered,
  defaultInlineFor,
  definitionsOf,
  lockFor,
  resolveTools,
  ToolFailure,
  ToolMissingError,
  waitField,
  waitsFor,
  ToolRegistry,
  toolNamed,
};
