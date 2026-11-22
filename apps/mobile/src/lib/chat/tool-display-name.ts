import { i18n } from '@/i18n';
import { isolateBidiText } from '@/lib/bidi';

/**
 * The tools a chat of this app can name, mapped to the catalog key that names
 * each one. A tool id is the harness's own and never the reader's language, so
 * a sentence that lists tools interpolates a value from here instead.
 *
 * Web search reuses the web-search row's title, so the row and this note call
 * it the same thing; the other three have a key of their own beside the note,
 * because "Web search" and "List settings" already mean something else.
 */
const TOOL_NAME_KEYS = {
  time: 'modelChat.localModels.tools.time',
  web_search: 'modelChat.webSearch.title',
  settings_list: 'modelChat.localModels.tools.settingsList',
  settings_set: 'modelChat.localModels.tools.settingsSet',
} as const satisfies Record<string, string>;

/**
 * The name a sentence gives one tool, wrapped in a bidi isolate.
 *
 * An unknown id — an MCP tool, whose name is its server's own and which no
 * catalog here can name — is returned raw rather than cased, so code never
 * forces English onto text it does not own. The isolate is what a bidi finding
 * asked for: a Latin identifier inside an Arabic sentence took the paragraph's
 * direction, so the list reordered and its full stop moved to the start of the
 * line. The isolate resolves each name from its own first strong character, and
 * is applied to a catalog name too, so an English label inside a right-to-left
 * sentence keeps its own order.
 */
export function toolDisplayName(tool: string): string {
  return isolateBidiText(toolName(tool));
}

/** The same name without its isolate, for a caller that isolates a longer run. */
function toolName(tool: string): string {
  // Object.hasOwn (not a bare index) so an id that names an inherited member
  // ('constructor', '__proto__') falls through to the raw id instead of handing
  // `i18n.t` a prototype member.
  const key: string | undefined = Object.hasOwn(TOOL_NAME_KEYS, tool)
    ? TOOL_NAME_KEYS[tool as keyof typeof TOOL_NAME_KEYS]
    : undefined;
  return key === undefined ? tool : i18n.t(key);
}

/**
 * One optional argument of a tool, named as `tool (argument)` and isolated as
 * one run, so the pair reads as a single item in a list and its bracket keeps
 * its place in a right-to-left sentence.
 */
export function toolArgumentDisplayName(tool: string, argument: string): string {
  return isolateBidiText(`${toolName(tool)} (${argument})`);
}
