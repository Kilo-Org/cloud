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
