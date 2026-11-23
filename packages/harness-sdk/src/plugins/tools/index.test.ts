import { expect, it } from 'vitest';
import * as tools from './index.js';

/**
 * What this entry point publishes.
 *
 * The barrel states its names instead of wildcarding five modules, so this is
 * the other half of that statement. A name added to a tool module and not to
 * the barrel never reaches a consumer, and a name dropped from the barrel
 * breaks one silently, because every other test here imports by path. This is
 * the guard `src/index.test.ts` keeps over the root, kept over the subpath
 * that publishes tools.
 *
 * It reads values only. The types are held by the barrel itself: its
 * `export type` lines name each one from the module that declares it, so a
 * module that stops exporting a type fails `pnpm typecheck` at the barrel. A
 * type removed from both is invisible here, exactly as it is at the root.
 */

/** Every value `@kilocode/harness-sdk/plugins/tools` carries. */
const values = ['questionTool', 'settingsTools', 'subagentTool', 'timeTool', 'todoTool'] as const;

it('publishes the five tool factories, and nothing it does not state', () => {
  expect(Object.keys(tools).sort()).toStrictEqual([...values].sort());
});
