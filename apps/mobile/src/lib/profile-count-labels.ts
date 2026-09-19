import { type TFunction } from 'i18next';

/**
 * The composition counts a profile row summarizes. The pure models resolve
 * them; this module maps each kind to the catalog keys that carry the reader's
 * own unit words, so no screen spells an English unit (`3 vars`, `2v`).
 */

type ProfileCountKind = 'vars' | 'mcp' | 'skills' | 'commands';

export type ProfileCountItem = {
  kind: ProfileCountKind;
  count: number;
};

/** Full unit words, e.g. `3 vars`. Used by the picker and selector rows. */
const COUNT_KEYS = {
  vars: 'profiles.counts.vars',
  mcp: 'profiles.counts.mcp',
  skills: 'profiles.counts.skills',
  commands: 'profiles.counts.commands',
} satisfies Record<ProfileCountKind, string>;

/** Localize each count in order, e.g. `['3 vars', '1 MCP']`. */
export function formatProfileCountItems(
  t: TFunction,
  items: readonly ProfileCountItem[]
): string[] {
  return items.map(item => t(COUNT_KEYS[item.kind], { count: item.count }));
}

/**
 * Compact keys for the profile-list subtitle, e.g. `3v`. MCP is absent
 * because its full unit word is already short, so it falls back to it.
 */
const SHORT_COUNT_KEYS = new Map<ProfileCountKind, string>([
  ['vars', 'profiles.counts.varsShort'],
  ['skills', 'profiles.counts.skillsShort'],
  ['commands', 'profiles.counts.commandsShort'],
]);

/** Localize each count with its compact suffix in order, e.g. `['3v', '1c']`. */
export function formatProfileCountItemsShort(
  t: TFunction,
  items: readonly ProfileCountItem[]
): string[] {
  return items.map(item =>
    t(SHORT_COUNT_KEYS.get(item.kind) ?? COUNT_KEYS[item.kind], { count: item.count })
  );
}
