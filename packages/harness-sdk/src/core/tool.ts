import { Context, Data, type Duration, Effect, Option } from 'effect';

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
   */
  readonly inlineFor?: Duration.DurationInput;
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
 * A call that outlived the model's patience, and what it eventually gave back.
 *
 * The model was told the call was still running and carried on without it. This
 * is the answer arriving late, on its way into a turn of its own.
 */
interface LateResult {
  readonly call: ToolCall;
  readonly result: ToolResult;
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

/** What the model is told about the tools, in the order the session named them. */
const definitionsOf = (tools: readonly Tool[]): readonly ToolDefinition[] =>
  tools.map(tool => tool.definition);

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
 * One permit for each tool that refused to overlap with itself. A tool that
 * allows overlap has no entry, so the usual path costs no lookup beyond a miss.
 */
const locksFor = (tools: readonly Tool[]): Effect.Effect<ReadonlyMap<string, Effect.Semaphore>> =>
  Effect.map(
    Effect.forEach(
      tools.filter(tool => tool.concurrent === false),
      tool =>
        Effect.map(Effect.makeSemaphore(1), (lock): readonly [string, Effect.Semaphore] => [
          tool.definition.name,
          lock,
        ])
    ),
    entries => new Map(entries)
  );

export type {
  JsonSchema,
  LateResult,
  Tool,
  ToolCall,
  ToolDefinition,
  ToolRegistryService,
  ToolResult,
};
export {
  definitionsOf,
  locksFor,
  resolveTools,
  ToolFailure,
  ToolMissingError,
  ToolRegistry,
  toolNamed,
};
