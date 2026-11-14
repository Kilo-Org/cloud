import { i18n } from '@/i18n';

/**
 * Every permission id the CLI can put in a permission request, mapped to the
 * catalog key that names it. Tool ids share the key their tool row renders
 * (`tool-card-display.ts`), so a row and the card sentence name a tool the same
 * way. The ids that are not tools — external directory access, the loop guard,
 * the agent manager, a sandbox escalation — have their own subject key.
 *
 * The card sentence reads "Allow {{permission}}?", so a value is a noun or
 * gerund phrase that fits that sentence, never an English-cased id.
 */
const LABEL_KEYS = {
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
  webfetch: 'agentChat.toolCard.toolWebFetch',
  websearch: 'agentChat.toolCard.toolWebSearch',
  codesearch: 'agentChat.toolCard.toolCodeSearch',
  todoread: 'agentChat.toolCard.toolTodo',
  todowrite: 'agentChat.toolCard.toolTodo',
  skill: 'agentChat.toolCard.toolSkill',
  lsp: 'agentChat.toolCard.toolLsp',
  browser_open: 'agentChat.toolCard.toolBrowser',
  notebook_read: 'agentChat.toolCard.toolNotebook',
  notebook_edit: 'agentChat.toolCard.toolNotebook',
  notebook_execute: 'agentChat.toolCard.toolNotebook',
  board_read: 'agentChat.toolCard.toolBoard',
  board_post: 'agentChat.toolCard.toolBoard',
  question: 'agentChat.toolCard.toolQuestion',
  suggest: 'agentChat.toolCard.toolSuggest',
  recall: 'agentChat.toolCard.toolRecall',
  repo_clone: 'agentChat.toolCard.toolRepoClone',
  repo_overview: 'agentChat.toolCard.toolRepoOverview',
  semantic_search: 'agentChat.toolCard.toolSemanticSearch',
  external_directory: 'agentChat.permissionCard.subjectExternalDirectory',
  doom_loop: 'agentChat.permissionCard.subjectDoomLoop',
  agent_manager: 'agentChat.permissionCard.subjectAgentManager',
  sandbox_escalation: 'agentChat.permissionCard.subjectSandboxEscalation',
} as const satisfies Record<string, string>;

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
 * The localized permission subject for interpolation into
 * `agentChat.permissionCard.allowQuestion`. An unknown id — one a newer CLI
 * sends before this app knows it — is returned unchanged, never `capitalize`d,
 * so code never forces English casing onto text the catalog owns.
 */
export function permissionToolLabel(permission: string): string {
  const stripped = stripNamespace(permission);
  // Object.hasOwn (not a bare index) so an id that names an inherited member
  // ('constructor', 'toString', '__proto__') falls through to the raw id
  // instead of handing `i18n.t` a prototype member.
  const key: string | undefined = Object.hasOwn(LABEL_KEYS, stripped)
    ? LABEL_KEYS[stripped as keyof typeof LABEL_KEYS]
    : undefined;
  return key ? i18n.t(key) : permission;
}
