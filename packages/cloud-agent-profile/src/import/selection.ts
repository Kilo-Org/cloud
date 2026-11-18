import type { ImportCategory, ParsedLocalConfig } from './types';

/** Identities the user chose to import, per category: agent slugs and other names. */
export type ImportSelection = Record<ImportCategory, string[]>;

export const IMPORT_CATEGORIES: readonly ImportCategory[] = [
  'agents',
  'commands',
  'skills',
  'instructions',
];

/** Identity of a parsed definition, as used by selection, preview and storage. */
export function importItemId(item: { slug: string } | { name: string }): string {
  return 'slug' in item ? item.slug : item.name;
}

export type SelectImportItemsResult =
  | { ok: true; config: ParsedLocalConfig }
  | { ok: false; category: ImportCategory; id: string };

function pick<T extends { slug: string } | { name: string }>(
  items: T[],
  ids: string[]
): { selected: T[]; missing: string | null } {
  const byId = new Map(items.map(item => [importItemId(item), item]));
  const missing = ids.find(id => !byId.has(id)) ?? null;
  const wanted = new Set(ids);
  return { selected: items.filter(item => wanted.has(importItemId(item))), missing };
}

/**
 * Narrow a parsed archive to the selected definitions. An identity that is not
 * importable from this archive fails the whole selection, so a stale or
 * forged selection cannot import something the preview did not offer.
 */
export function selectImportItems(
  config: ParsedLocalConfig,
  selection: ImportSelection
): SelectImportItemsResult {
  const agents = pick(config.agents, selection.agents);
  if (agents.missing !== null) return { ok: false, category: 'agents', id: agents.missing };
  const commands = pick(config.commands, selection.commands);
  if (commands.missing !== null) return { ok: false, category: 'commands', id: commands.missing };
  const skills = pick(config.skills, selection.skills);
  if (skills.missing !== null) return { ok: false, category: 'skills', id: skills.missing };
  const instructions = pick(config.instructions, selection.instructions);
  if (instructions.missing !== null) {
    return { ok: false, category: 'instructions', id: instructions.missing };
  }
  return {
    ok: true,
    config: {
      agents: agents.selected,
      commands: commands.selected,
      skills: skills.selected,
      instructions: instructions.selected,
    },
  };
}
