/**
 * Wire-shape for kilo slash commands as exposed to web clients.
 *
 * Kilo's `Command.Info` (from `@kilocode/sdk`) carries a `template` field that
 * can be large and is only meaningful server-side (kilo expands `$1`, `$2`,
 * `$ARGUMENTS` against the template). We strip it before broadcasting.
 */
export type SlashCommandInfo = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: 'command' | 'mcp' | 'skill';
  hints: string[];
  subtask?: boolean;
};

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
