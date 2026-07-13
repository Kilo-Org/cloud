import { type SlashCommandInfo } from 'cloud-agent-sdk';

type ChatComposerSubmission =
  | { type: 'prompt'; prompt: string }
  | { type: 'command'; command: string; arguments: string }
  | { type: 'attachment-error' };

const SLASH_COMMAND_PATTERN = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/;
const SLASH_CANDIDATE_PATTERN = /^\/[\w.-]*$/;

/**
 * Returns the input when it can still match a command name, `null` otherwise.
 * Keeping non-candidates collapsed to `null` lets the composer skip
 * re-rendering on every keystroke of ordinary prose.
 */
export function getSlashCommandCandidate(input: string): string | null {
  return SLASH_CANDIDATE_PATTERN.test(input) ? input : null;
}

export function getSlashCommandSuggestions(
  input: string,
  commands: SlashCommandInfo[]
): SlashCommandInfo[] {
  const match = /^\/([\w.-]*)$/.exec(input);
  if (!match) {
    return [];
  }

  const prefix = match[1] ?? '';
  return commands.filter(command => command.name.startsWith(prefix));
}

export function prepareChatComposerSubmission(
  input: string,
  commands: SlashCommandInfo[],
  hasAttachments: boolean
): ChatComposerSubmission {
  const trimmed = input.trim();
  const match = SLASH_COMMAND_PATTERN.exec(trimmed);
  const commandName = match?.[1];
  const recognized = commandName ? commands.some(command => command.name === commandName) : false;

  if (!recognized || !commandName) {
    return { type: 'prompt', prompt: trimmed };
  }
  if (hasAttachments) {
    return { type: 'attachment-error' };
  }
  return {
    type: 'command',
    command: commandName,
    arguments: match[2]?.trim() ?? '',
  };
}
