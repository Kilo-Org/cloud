import { type TFunction } from 'i18next';

/**
 * The counts one profile summary reports, in one canonical order. The pure
 * models resolve them; this module maps each kind to the catalog key that
 * carries the reader's own unit words, so no screen spells an English unit
 * (`3 vars`, `2v`).
 *
 * Both command collections are real and distinct, so each keeps its own unit
 * word: `commands` is the profile's Kilo slash commands, the collection the web
 * profile chip and the picker summarize; `setupCommands` is the shell command
 * list the profile runs before a session starts.
 */

type ProfileCountKind = 'vars' | 'mcp' | 'skills' | 'commands' | 'setupCommands' | 'agents';

export type ProfileCountItem = {
  kind: ProfileCountKind;
  count: number;
};

/** The count fields a profile summary carries, as the server's `ProfileSummary`. */
export type ProfileCountCounts = {
  varCount: number;
  mcpServerCount: number;
  skillCount: number;
  kiloCommandCount: number;
  commandCount: number;
  agentCount: number;
};

/** Full unit words, e.g. `3 vars`. Every profile surface renders these. */
const COUNT_KEYS = {
  vars: 'profiles.counts.vars',
  mcp: 'profiles.counts.mcp',
  skills: 'profiles.counts.skills',
  commands: 'profiles.counts.commands',
  setupCommands: 'profiles.counts.setupCommands',
  agents: 'profiles.counts.agents',
} satisfies Record<ProfileCountKind, string>;

/**
 * The non-zero counts a profile summary shows, in canonical order (vars, MCP,
 * skills, slash commands, setup commands, agents). Empty when the profile has
 * nothing configured, so the surface renders without a summary line.
 */
export function profileCountItems(counts: ProfileCountCounts): ProfileCountItem[] {
  const items: ProfileCountItem[] = [
    { kind: 'vars', count: counts.varCount },
    { kind: 'mcp', count: counts.mcpServerCount },
    { kind: 'skills', count: counts.skillCount },
    { kind: 'commands', count: counts.kiloCommandCount },
    { kind: 'setupCommands', count: counts.commandCount },
    { kind: 'agents', count: counts.agentCount },
  ];
  return items.filter(item => item.count > 0);
}

/** Localize each count in order, e.g. `['3 vars', '1 MCP']`. */
export function formatProfileCountItems(
  t: TFunction,
  items: readonly ProfileCountItem[]
): string[] {
  return items.map(item => t(COUNT_KEYS[item.kind], { count: item.count }));
}
