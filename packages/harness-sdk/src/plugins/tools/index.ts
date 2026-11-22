/**
 * The tools this package ships, and the types a caller writes one with.
 *
 * Every name is stated here rather than wildcarded from its module. A tool
 * module grows helpers and internal types as it is worked on, and a wildcard
 * would publish each of them the moment it is written: the entry point's API
 * would then be whatever five files happen to export. Stated, a new export
 * inside `question.ts` stays `question.ts`'s business until somebody adds it
 * to this list on purpose.
 *
 * `src/plugins/tools/index.test.ts` asserts the list, so a name added here and
 * a name dropped here are both visible in a failing test rather than at a
 * consumer's import.
 */

export type { Answer, Asker, Choice, Question, QuestionOptions } from './question.js';
export { questionTool } from './question.js';
export type {
  AppSetting,
  AppSettingKind,
  AppSettingsService,
  SettingsToolsOptions,
} from './settings.js';
export { settingsTools } from './settings.js';
export type { SubagentContext, SubagentOptions, SubagentReport } from './subagent.js';
export { subagentTool } from './subagent.js';
export type { TimeOptions } from './time.js';
export { timeTool } from './time.js';
export type { Todo, TodoOptions, TodoState } from './todo.js';
export { todoTool } from './todo.js';
