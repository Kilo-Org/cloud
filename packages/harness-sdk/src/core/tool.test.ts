import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';
import { resolveTools, type Tool, ToolMissingError, ToolRegistry } from './tool.js';

/**
 * The tools a session offers are resolved when it opens, not when a question
 * happens to want one. A name nothing holds is a session that would send a
 * prefix promising a tool it cannot run, and the model would call it.
 */

const named = (name: string): Tool => ({
  definition: { name, description: name, parameters: { type: 'object', properties: {} } },
  run: () => Effect.succeed('done'),
});

const registry = (...tools: readonly Tool[]) => Layer.succeed(ToolRegistry, { tools });

const resolve = (names: readonly string[], ...tools: readonly Tool[]) =>
  Effect.runPromise(Effect.either(Effect.provide(resolveTools(names), registry(...tools))));

it('resolves the names in the order the session asked for them', async () => {
  const resolved = await resolve(['b', 'a'], named('a'), named('b'));

  /* The order is the order of the prefix, not the order of the registry. */
  expect(resolved._tag === 'Right' && resolved.right.map(tool => tool.definition.name)).toEqual([
    'b',
    'a',
  ]);
});

it('refuses to open a session naming a tool nothing holds', async () => {
  const resolved = await resolve(['a', 'missing'], named('a'));

  expect(resolved._tag === 'Left' && resolved.left).toBeInstanceOf(ToolMissingError);
});

it('asks for no registry when the session names no tool', async () => {
  /* No layer at all, which is what a caller with no tools provides. */
  const resolved = await Effect.runPromise(resolveTools([]));

  expect(resolved).toEqual([]);
});
