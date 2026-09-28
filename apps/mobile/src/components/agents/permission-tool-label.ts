import { i18n } from '@/i18n';

/**
 * Known tool ids mapped to the same catalog keys the tool cards render
 * (`tool-card-display.ts`). The card sentence reads "Allow {{permission}}?",
 * so the value must be the tool's localized name, never an English-cased id.
 *
 * `webfetch`, `websearch`, `codesearch`, `todoread` and `todowrite` are known
 * ids with no translated name in the catalog — the tool cards render the raw
 * id for them too — so their entry is `null` (shown as the untouched id).
 */
const TOOL_LABEL_KEYS = {
  read: 'agentChat.toolCard.toolRead',
  edit: 'agentChat.toolCard.toolEdit',
  write: 'agentChat.toolCard.toolWrite',
  bash: 'agentChat.toolCard.toolBash',
  glob: 'agentChat.toolCard.toolGlob',
  grep: 'agentChat.toolCard.toolGrep',
  list: 'agentChat.toolCard.toolList',
  patch: 'agentChat.toolCard.toolPatch',
  apply_patch: 'agentChat.toolCard.toolPatch',
  task: 'agentChat.toolCard.toolTask',
  webfetch: null,
  websearch: null,
  codesearch: null,
  todoread: null,
  todowrite: null,
} satisfies Record<string, string | null>;

/**
 * Some permission ids arrive namespaced (`file_write`, `bash_read`). Strip the
 * namespace before the lookup; an id that misses both still returns raw.
 */
const TOOL_NAMESPACE_PREFIXES = ['file_', 'bash_'] as const;

function stripNamespace(permission: string): string {
  for (const prefix of TOOL_NAMESPACE_PREFIXES) {
    if (permission.startsWith(prefix)) {
      return permission.slice(prefix.length);
    }
  }
  return permission;
}

/**
 * The localized tool name for a permission id, for interpolation into
 * `agentChat.permissionCard.allowQuestion`. A known id with no catalog name
 * and an unknown id are both returned unchanged — never `capitalize`d — so
 * code never forces English casing onto text the catalog owns.
 */
export function permissionToolLabel(permission: string): string {
  const stripped = stripNamespace(permission);
  // Object.hasOwn (not a bare index) so an id that names an inherited member
  // ('constructor', 'toString', '__proto__') falls through to the raw id
  // instead of handing `i18n.t` a prototype member.
  const key: string | null | undefined = Object.hasOwn(TOOL_LABEL_KEYS, stripped)
    ? TOOL_LABEL_KEYS[stripped as keyof typeof TOOL_LABEL_KEYS]
    : undefined;
  return key ? i18n.t(key) : permission;
}
