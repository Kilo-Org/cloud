import { type TFunction } from 'i18next';

/**
 * The catalog key of every tool-detail row label the sheet knows. A built-in
 * tool's argument names and the question projection's row names are wire
 * identifiers, so the sheet translates them; a key this map does not name
 * belongs to an MCP or plugin tool, whose argument names the agent chose, so it
 * stays as sent.
 *
 * Five labels already exist under another surface's key. The i18n check keeps
 * one key per piece of copy, so the map points at those keys rather than
 * repeating their English string:
 * `profiles.commandLabel`, `prReview.description`, `profiles.mcp.url`,
 * `todos.listSettings.name` and `agentChat.suggestion.title`.
 */
const TOOL_FIELD_LABEL_KEYS = {
  filePath: 'agentChat.partDetail.field.filePath',
  path: 'agentChat.partDetail.field.path',
  offset: 'agentChat.partDetail.field.offset',
  limit: 'agentChat.partDetail.field.limit',
  pattern: 'agentChat.partDetail.field.pattern',
  include: 'agentChat.partDetail.field.include',
  patchText: 'agentChat.partDetail.field.patchText',
  query: 'agentChat.partDetail.field.query',
  prompt: 'agentChat.partDetail.field.prompt',
  header: 'agentChat.partDetail.field.header',
  question: 'agentChat.partDetail.field.question',
  options: 'agentChat.partDetail.field.options',
  command: 'profiles.commandLabel',
  description: 'prReview.description',
  url: 'profiles.mcp.url',
  name: 'todos.listSettings.name',
  suggest: 'agentChat.suggestion.title',
} satisfies Record<string, string>;

type ToolFieldName = keyof typeof TOOL_FIELD_LABEL_KEYS;

function isToolFieldName(key: string): key is ToolFieldName {
  return Object.hasOwn(TOOL_FIELD_LABEL_KEYS, key);
}

/**
 * A part with two or more questions numbers its rows (`header 1`, `options 2`)
 * so each group stays readable. The ordinal is a position, not copy: it keeps
 * its place after the translated label.
 */
const numberedFieldKey = /^(.*) (\d+)$/;

/** The field row's label in the reader's language, or the raw key for an unknown tool. */
export function toolFieldLabel(t: TFunction, key: string): string {
  const numbered = numberedFieldKey.exec(key);
  const base = numbered?.[1] ?? key;
  if (!isToolFieldName(base)) {
    return key;
  }
  const label = t(TOOL_FIELD_LABEL_KEYS[base]);
  const ordinal = numbered?.[2];
  return ordinal === undefined ? label : `${label} ${ordinal}`;
}
