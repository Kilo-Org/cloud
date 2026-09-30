import {
  DEFAULT_SLASH_COMMANDS,
  DEFAULT_SLASH_COMMANDS_SOURCE,
  type SlashCommandInfo,
} from './default-slash-commands.generated';

export { DEFAULT_SLASH_COMMANDS, DEFAULT_SLASH_COMMANDS_SOURCE, type SlashCommandInfo };

const SESSION_SLASH_COMMANDS = [
  {
    name: 'compact',
    description: 'compact the current session context',
    hints: [],
  },
] satisfies SlashCommandInfo[];

/** Parsed result of "/name rest of the line" from the chat composer. */
export type SlashCommandInvocation = {
  command: string;
  arguments: string;
};

const SLASH_RE = /^\s*\/([\w.-]+)(?:\s+([\s\S]*))?\s*$/;

/**
 * Parse a chat input string of the form "/<name> [args...]".
 * Returns null if the input is not a slash invocation. Args are joined back
 * into a single string and passed verbatim — kilo handles `$1/$2/$ARGUMENTS`
 * substitution against the command template.
 */
export function parseSlashInvocation(text: string): SlashCommandInvocation | null {
  const match = SLASH_RE.exec(text);
  if (!match) return null;
  const [, command, rest] = match;
  return {
    command,
    arguments: rest?.trim() ?? '',
  };
}

/**
 * Convert a kilo SDK `Command.Info` into the trimmed wire shape.
 * The SDK's response shape is `unknown` to us at the type level, so accept a
 * loose object and validate the required fields.
 */
export function toSlashCommandInfo(raw: unknown): SlashCommandInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0) return null;
  return {
    name: r.name,
    description: typeof r.description === 'string' ? r.description : undefined,
    agent: typeof r.agent === 'string' ? r.agent : undefined,
    model: typeof r.model === 'string' ? r.model : undefined,
    source:
      r.source === 'command' || r.source === 'mcp' || r.source === 'skill' ? r.source : undefined,
    hints: Array.isArray(r.hints) ? r.hints.filter((h): h is string => typeof h === 'string') : [],
    subtask: typeof r.subtask === 'boolean' ? r.subtask : undefined,
  };
}

/**
 * Catalog bounds shared with the remote CLI catalog
 * (`packages/cloud-agent-sdk/src/schemas.ts`). The cloud-agent path builds its
 * own catalog in the wrapper and now carries skill rows too, so it must respect
 * the same 256-command / 512 KiB limits the composer is sized for.
 */
export const SLASH_COMMAND_CATALOG_MAX_COMMANDS = 256;
export const SLASH_COMMAND_CATALOG_MAX_SERIALIZED_BYTES = 512 * 1024;

export type BoundedSlashCommandCatalog = {
  commands: SlashCommandInfo[];
  /** Non-skill rows removed to bring the catalog back inside its bounds. */
  dropped: number;
  /**
   * True when the returned catalog still exceeds a bound because the skill rows
   * alone are over it. Skills are never truncated, so the caller must report
   * the full catalog instead of hiding skills silently.
   */
  overLimit: boolean;
};

/**
 * The bound status a client needs to tell the reader that the catalog the
 * wrapper sent is not the whole catalog: `dropped` non-skill rows are missing,
 * and `overLimit` means the rows kept still exceed a bound because the skill
 * rows alone are over it.
 */
export type SlashCommandCatalogStatus = {
  dropped: number;
  overLimit: boolean;
};

/**
 * The status to report for a bounded catalog, or `undefined` when the catalog
 * is within every bound. An unbounded catalog adds nothing to the wire payload,
 * so an absent status always means "the whole catalog was sent".
 */
export function slashCommandCatalogStatus(
  bounded: BoundedSlashCommandCatalog
): SlashCommandCatalogStatus | undefined {
  return bounded.dropped > 0 || bounded.overLimit
    ? { dropped: bounded.dropped, overLimit: bounded.overLimit }
    : undefined;
}

/**
 * Bound a catalog to the shared limits without ever truncating a skill row.
 *
 * Skill rows always survive: non-skill rows fill the remaining count budget in
 * their original order, and if the payload is still over the byte limit,
 * non-skill rows are dropped from the end. When only skill rows remain and the
 * payload is still over the byte limit the skills are kept anyway, so a skill
 * is never truncated; the result is flagged `overLimit` so the caller reports
 * the full catalog instead of hiding skills silently.
 */
export function boundSlashCommandCatalog(commands: SlashCommandInfo[]): BoundedSlashCommandCatalog {
  if (isWithinCatalogBounds(commands)) {
    return { commands, dropped: 0, overLimit: false };
  }

  const skills = commands.filter(command => command.source === 'skill');
  const nonSkills = commands.filter(command => command.source !== 'skill');
  const countBudget = Math.max(0, SLASH_COMMAND_CATALOG_MAX_COMMANDS - skills.length);
  const kept = new Set<SlashCommandInfo>([...skills, ...nonSkills.slice(0, countBudget)]);
  const bounded = commands.filter(command => kept.has(command));

  while (serializedCatalogBytes(bounded) > SLASH_COMMAND_CATALOG_MAX_SERIALIZED_BYTES) {
    let dropIndex = -1;
    for (let index = bounded.length - 1; index >= 0; index -= 1) {
      if (bounded[index]?.source !== 'skill') {
        dropIndex = index;
        break;
      }
    }
    if (dropIndex === -1) break;
    bounded.splice(dropIndex, 1);
  }

  return {
    commands: bounded,
    dropped: commands.length - bounded.length,
    overLimit: !isWithinCatalogBounds(bounded),
  };
}

function isWithinCatalogBounds(commands: SlashCommandInfo[]): boolean {
  return (
    commands.length <= SLASH_COMMAND_CATALOG_MAX_COMMANDS &&
    serializedCatalogBytes(commands) <= SLASH_COMMAND_CATALOG_MAX_SERIALIZED_BYTES
  );
}

function serializedCatalogBytes(commands: SlashCommandInfo[]): number {
  return new TextEncoder().encode(JSON.stringify(commands)).byteLength;
}

/**
 * Return the provided command list when it is non-empty, otherwise fall back
 * to the hardcoded default catalog. Used both server-side (DO storage) and
 * client-side (hook) so empty always means "defaults" rather than "none yet".
 * Session actions such as compaction are local Kilo actions rather than
 * registered prompt commands, so append them when the live catalog omits them.
 */
export function commandsOrDefault(
  commands: SlashCommandInfo[] | null | undefined
): SlashCommandInfo[] {
  return withSessionSlashCommands(
    commands && commands.length > 0 ? commands : DEFAULT_SLASH_COMMANDS
  );
}

function withSessionSlashCommands(commands: SlashCommandInfo[]): SlashCommandInfo[] {
  const names = new Set(commands.map(command => command.name));
  const missing = SESSION_SLASH_COMMANDS.filter(command => !names.has(command.name));
  return missing.length > 0 ? [...commands, ...missing] : commands;
}
