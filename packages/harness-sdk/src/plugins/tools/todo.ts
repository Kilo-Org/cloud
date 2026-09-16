import { Effect, Ref } from 'effect';
import { createAssert } from 'typia';
import { type JsonSchema, type Tool, ToolFailure, type ToolCall } from '../../core/tool.js';

/**
 * The list a model keeps of what it is doing.
 *
 * A model given a task of several steps forgets one, does two at once, or says
 * it is finished with a step still open. Writing the steps down and reading
 * them back is the fix every harness reaches for, and every harness writes the
 * same one, which is what makes it the package's.
 *
 * The model sends the whole list every time rather than a change to it. That is
 * deliberate and it is the difference between a tool that works and one that
 * does not: patching needs stable identifiers, models invent them, and a patch
 * against an identifier that does not exist either fails the call or silently
 * edits the wrong line. A whole list cannot be wrong about what it means.
 *
 * What comes back is the list as it now stands, so the model reads its own
 * state rather than trusting what it thinks it sent.
 */

/** Where one step has got to. */
type TodoState = 'pending' | 'doing' | 'done';

interface Todo {
  readonly text: string;
  readonly state: TodoState;
}

/** What the model sends. Anything else is a failed result and a chance to retry. */
interface Asked {
  readonly todos: readonly Todo[];
}

const assertAsked = createAssert<Asked>();

const parameters: JsonSchema = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description:
        'The whole list, in order, as it should now stand. Send every step ' +
        'every time, including the ones that have not changed: this replaces ' +
        'the list rather than adding to it.',
      items: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The step, as one short imperative line.',
          },
          state: {
            type: 'string',
            enum: ['pending', 'doing', 'done'],
            description:
              'Where this step has got to. Exactly one step is `doing` at a ' +
              'time; mark it `done` before starting the next.',
          },
        },
        required: ['text', 'state'],
        additionalProperties: false,
      },
    },
  },
  required: ['todos'],
  additionalProperties: false,
};

const description =
  'Writes down what you are doing, and reads the list back. Use it for a task ' +
  'of several steps: put the steps down before you start, mark one `doing` ' +
  'while you are on it, and mark it `done` the moment it is finished rather ' +
  'than in a batch at the end. Send the whole list every time — it replaces ' +
  'what is there. A task of one step does not need it.';

const marks: Readonly<Record<TodoState, string>> = {
  pending: '[ ]',
  doing: '[>]',
  done: '[x]',
};

/** The list as the model reads it back. */
const wordsFor = (todos: readonly Todo[]): string =>
  todos.length === 0
    ? 'The list is empty.'
    : todos.map(todo => `${marks[todo.state]} ${todo.text}`).join('\n');

/** What the caller may change. Everything about the steps is the model's. */
interface TodoOptions {
  /** The name the model calls it by, for a harness that already has one. */
  readonly name?: string;
  /**
   * Told the list every time it changes, for a harness that draws it.
   *
   * It may fail, and a failure reaches the model as a failed result: a harness
   * that could not draw the list has told the model something worth knowing,
   * which is that the person cannot see what it wrote down.
   */
  readonly onChanged?: (todos: readonly Todo[]) => Effect.Effect<void, unknown>;
}

/**
 * The tool.
 *
 * **The list belongs to this tool, not to a session.** It is held in a `Ref`
 * made when the tool is built, so a registry shared by a parent and its
 * subagents shares one list between them. That is right for a harness whose
 * subagent works on the parent's plan, and wrong for one whose subagents run
 * unrelated errands; the second builds a tool per session. There is no third
 * option the package could pick, because a tool is handed no session — see
 * "A tool is handed no context" in AGENTS.md.
 *
 * It holds one permit, beside the list it protects. The model asks for several
 * tools at once and this one replaces the whole list, so two overlapping calls
 * would lose one of the two writes entirely rather than merging badly.
 */
const todoTool = (options?: TodoOptions): Tool => {
  const held = Ref.unsafeMake<readonly Todo[]>([]);
  const permit = Effect.unsafeMakeSemaphore(1);
  return {
    definition: { name: options?.name ?? 'todo', description, parameters },
    run: (call: ToolCall) =>
      permit.withPermits(1)(
        Effect.try({
          try: () => assertAsked(JSON.parse(call.arguments)),
          catch: cause => new ToolFailure({ cause }),
        }).pipe(
          Effect.tap(({ todos }) => Ref.set(held, todos)),
          Effect.tap(({ todos }) =>
            (options?.onChanged?.(todos) ?? Effect.void).pipe(
              Effect.mapError(cause =>
                cause instanceof ToolFailure ? cause : new ToolFailure({ cause })
              )
            )
          ),
          Effect.flatMap(() => Effect.map(Ref.get(held), wordsFor))
        )
      ),
  };
};

export type { Todo, TodoOptions, TodoState };
export { todoTool };
