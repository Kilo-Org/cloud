import { Duration, Effect } from 'effect';
import { assert } from 'typia';
import { expect, it } from 'vitest';
import { type ToolCall, ToolFailure } from '../../core/tool.js';
import { type Answer, type Asker, type Question, questionTool } from './question.js';

/**
 * The one tool the package ships. What the model sends is the model's, and
 * every one of these is a shape it will send sooner or later; what comes back
 * is what the model then has to read, and it has to read it without a second
 * round asking what an answer meant.
 */

const call = (args: unknown): ToolCall => ({
  id: 'tc_1',
  name: 'question',
  arguments: JSON.stringify(args),
});

/** An asker that answers from a script and records what it was asked. */
const asking = (
  answers: readonly Answer[] | ToolFailure
): { readonly asked: Question[][]; readonly ask: Asker } => {
  const asked: Question[][] = [];
  const ask: Asker = questions => {
    asked.push([...questions]);
    return answers instanceof ToolFailure ? Effect.fail(answers) : Effect.succeed(answers);
  };
  return { asked, ask };
};

const run = (tool: ReturnType<typeof questionTool>, one: ToolCall) =>
  Effect.runPromise(Effect.either(tool.run(one)));

const said = async (
  answers: readonly Answer[],
  questions: readonly Partial<Question>[]
): Promise<string> => {
  const { ask } = asking(answers);
  const got = await run(questionTool(ask), call({ questions }));
  return got._tag === 'Right' ? got.right : `failed: ${String(got.left.cause)}`;
};

it('asks everything in one call and answers in the order the model asked', async () => {
  const { asked, ask } = asking([
    { id: 'where', text: 'eu-west-1' },
    { id: 'db', chosen: ['postgres'] },
  ]);

  const got = await run(
    questionTool(ask),
    call({
      questions: [
        {
          id: 'db',
          prompt: 'Which database?',
          choices: [{ value: 'postgres', label: 'Postgres' }],
        },
        { id: 'where', prompt: 'Which region?' },
      ],
    })
  );

  expect(asked).toHaveLength(1);
  /* The model's order, not the caller's. A model reading its own questions back
     out of order has to work out which answer went with which. */
  expect(got._tag === 'Right' && got.right).toBe(
    'Which database? [db]\npostgres\n\nWhich region? [where]\neu-west-1'
  );
});

it('reports every choice when several were picked', async () => {
  const answered = await said(
    [{ id: 'r', chosen: ['eu-west-1', 'us-east-1'] }],
    [{ id: 'r', prompt: 'Which regions?', multiple: true }]
  );

  expect(answered).toBe('Which regions? [r]\neu-west-1, us-east-1');
});

it('says a question went unanswered rather than leaving a blank', async () => {
  /* Three ways to answer nothing, and the model must not have to guess that a
     blank line meant anything. */
  const answered = await said(
    [{ id: 'b' }, { id: 'c', text: '' }],
    [
      { id: 'a', prompt: 'Skipped outright?' },
      { id: 'b', prompt: 'Answered with nothing?' },
      { id: 'c', prompt: 'Answered with an empty string?' },
    ]
  );

  expect(answered.split('\n\n')).toEqual([
    'Skipped outright? [a]\n(not answered)',
    'Answered with nothing? [b]\n(not answered)',
    'Answered with an empty string? [c]\n(not answered)',
  ]);
});

it('drops an answer to a question nobody asked', async () => {
  const answered = await said(
    [
      { id: 'other', text: 'i answered something else' },
      { id: 'a', text: 'yes' },
    ],
    [{ id: 'a', prompt: 'Go ahead?' }]
  );

  /* Otherwise the caller decides what the model believes it asked. */
  expect(answered).toBe('Go ahead? [a]\nyes');
});

it('hands the model back what was wrong with its arguments', async () => {
  const { asked, ask } = asking([]);

  const got = await run(questionTool(ask), call({ questions: [{ prompt: 'no id' }] }));

  expect(got._tag === 'Left' && String(got.left.cause)).toContain('questions[0].id');
  /* And nobody was disturbed over a call the model got wrong. */
  expect(asked).toEqual([]);
});

it('hands the model back arguments that are not JSON at all', async () => {
  const { ask } = asking([]);

  const got = await run(questionTool(ask), { id: 'tc_1', name: 'question', arguments: '{oops' });

  expect(got._tag).toBe('Left');
});

it('fails the call rather than the session when the asking itself fails', async () => {
  const { ask } = asking(new ToolFailure({ cause: 'nobody is at the terminal' }));

  const got = await run(questionTool(ask), call({ questions: [{ id: 'a', prompt: 'Go ahead?' }] }));

  /* A failed result, which the model can act on. Anything else would end a
     session because somebody closed a window. */
  expect(got._tag === 'Left' && String(got.left.cause)).toContain('nobody is at the terminal');
});

it('refuses to overlap with itself, so two rounds never ask over each other', () => {
  const { ask } = asking([]);

  expect({ concurrent: questionTool(ask).concurrent }).toEqual({ concurrent: false });
});

it('takes the name and the deadline a harness gives it', () => {
  const { ask } = asking([]);

  const tool = questionTool(ask, { name: 'ask_user', inlineFor: Duration.seconds(5) });

  expect({ name: tool.definition.name, inlineFor: tool.inlineFor }).toEqual({
    name: 'ask_user',
    inlineFor: Duration.seconds(5),
  });
});

it('describes the questions it takes, so the model can write one', () => {
  const { ask } = asking([]);

  const { parameters } = questionTool(ask).definition;

  /* The model writes this shape from the schema alone. A property the schema
     does not name is a property the model never sends. */
  const { items } = assert<{
    readonly items: {
      readonly properties: Readonly<Record<string, unknown>>;
      readonly required: readonly string[];
    };
  }>(parameters.properties['questions']);
  expect(Object.keys(items.properties)).toEqual([
    'id',
    'prompt',
    'choices',
    'multiple',
    'optional',
  ]);
  expect(items.required).toEqual(['id', 'prompt']);
});
