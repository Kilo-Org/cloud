import { expect, it } from 'vitest';
import * as tools from './index.js';
import type {
  Answer,
  AppSetting,
  AppSettingKind,
  AppSettingsService,
  Asker,
  Choice,
  Question,
  QuestionOptions,
  SettingsToolsOptions,
  SubagentContext,
  SubagentOptions,
  SubagentReport,
  TimeOptions,
  Todo,
  TodoOptions,
  TodoState,
} from './index.js';

/**
 * What this entry point publishes.
 *
 * The barrel states its names instead of wildcarding five modules, so this is
 * the other half of that statement. A name added to a tool module and not to
 * the barrel never reaches a consumer, and a name dropped from the barrel
 * breaks one silently, because every other test here imports by path. This is
 * the guard `src/index.test.ts` keeps over the root, kept over the subpath
 * that publishes tools.
 */

/** Every value `@kilocode/harness-sdk/plugins/tools` carries. */
const values = ['questionTool', 'settingsTools', 'subagentTool', 'timeTool', 'todoTool'] as const;

/**
 * Every type it carries.
 *
 * The compiler is what holds this half: the array is never built, and naming a
 * type the barrel stopped exporting fails `pnpm typecheck` rather than a
 * consumer's build. A type leaves no trace at runtime, so no assertion can.
 */
type Carried = readonly [
  Answer,
  Asker,
  Choice,
  Question,
  QuestionOptions,
  AppSetting,
  AppSettingKind,
  AppSettingsService,
  SettingsToolsOptions,
  SubagentContext,
  SubagentOptions,
  SubagentReport,
  TimeOptions,
  Todo,
  TodoOptions,
  TodoState,
];

it('publishes the five tool factories, and nothing it does not state', () => {
  expect(Object.keys(tools).sort()).toStrictEqual([...values].sort());
});

it('carries the type of every argument and result a caller writes a tool with', () => {
  const carried: Carried | undefined = undefined;

  expect(carried).toBeUndefined();
});
