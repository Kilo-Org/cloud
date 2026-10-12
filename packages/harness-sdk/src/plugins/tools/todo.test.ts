import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { type ToolCall, ToolFailure } from '../../core/tool.js';
import { type Todo, todoTool } from './todo.js';

/**
 * What the model sends is the model's, and every shape here is one it will send
 * sooner or later. What comes back is what it then has to read.
 */

const call = (args: unknown): ToolCall => ({
  id: 'tc_1',
  name: 'todo',
  arguments: JSON.stringify(args),
});

const run = (tool: ReturnType<typeof todoTool>, one: ToolCall) =>
  Effect.runPromise(Effect.either(tool.run(one)));

const said = async (tool: ReturnType<typeof todoTool>, todos: readonly unknown[]) => {
  const got = await run(tool, call({ todos }));
  return got._tag === 'Right' ? got.right : `FAILED: ${String(got.left.cause)}`;
};

it('reads the list back with a mark for each state', async () => {
  const list = await said(todoTool(), [
    { text: 'Read the spec', state: 'done' },
    { text: 'Write the parser', state: 'doing' },
    { text: 'Ship it', state: 'pending' },
  ]);

  expect(list).toBe('[x] Read the spec\n[>] Write the parser\n[ ] Ship it');
});

it('replaces the list rather than adding to it', async () => {
  const tool = todoTool();
  await said(tool, [{ text: 'First', state: 'pending' }]);

  /* The second call does not mention the first step, so the first step is gone.
     A model that meant to keep it sends it again; that is the whole contract. */
  expect(await said(tool, [{ text: 'Second', state: 'doing' }])).toBe('[>] Second');
});

it('says so rather than answering nothing when the list is emptied', async () => {
  const tool = todoTool();
  await said(tool, [{ text: 'First', state: 'pending' }]);

  expect(await said(tool, [])).toBe('The list is empty.');
});

it('keeps one list per tool, not one per call', async () => {
  const one = todoTool();
  const other = todoTool();
  await said(one, [{ text: 'Mine', state: 'doing' }]);

  /* Two tools built separately do not share a list. A harness that wants a
     list per session builds a tool per session, which is what makes that work. */
  expect(await said(other, [])).toBe('The list is empty.');
  expect(await said(one, [{ text: 'Mine', state: 'done' }])).toBe('[x] Mine');
});

it('tells the harness what changed, so it can draw it', async () => {
  const drawn: (readonly Todo[])[] = [];
  const tool = todoTool({ onChanged: todos => Effect.sync(() => void drawn.push(todos)) });

  await said(tool, [{ text: 'Only', state: 'pending' }]);

  expect(drawn).toStrictEqual([[{ text: 'Only', state: 'pending' }]]);
});

it('tells the model when the harness could not draw the list', async () => {
  const tool = todoTool({ onChanged: () => Effect.fail(new Error('no terminal')) });

  const got = await run(tool, call({ todos: [{ text: 'Only', state: 'pending' }] }));

  /* The person cannot see what the model wrote down, which is a thing the model
     needs to know rather than a thing to swallow. */
  expect(got._tag).toBe('Left');
  expect(got._tag === 'Left' && got.left).toBeInstanceOf(ToolFailure);
});

it('refuses a state it does not have, rather than storing it', async () => {
  const tool = todoTool();

  const got = await run(tool, call({ todos: [{ text: 'Only', state: 'nearly' }] }));

  expect(got._tag).toBe('Left');
  /* And the list is untouched, so a bad call does not lose what was there. */
  expect(await said(tool, [])).toBe('The list is empty.');
});

it('refuses a step with no text', async () => {
  const got = await run(todoTool(), call({ todos: [{ state: 'pending' }] }));

  expect(got._tag).toBe('Left');
});

it('refuses arguments that are not a list at all', async () => {
  const got = await run(todoTool(), { id: 'tc_1', name: 'todo', arguments: 'not json' });

  expect(got._tag).toBe('Left');
});
