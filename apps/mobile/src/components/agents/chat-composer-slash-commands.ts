import { type ActiveSessionType, type SlashCommandInfo } from 'cloud-agent-sdk';
import { type RemoteCommandState } from 'cloud-agent-sdk/remote-command-catalog';

/**
 * Local reserved /new command — surfaced only for remote sessions, never
 * pushed to the CLI. Remote CLIs have no /new (they create sessions through a
 * dedicated control message), so a slash-style "new" must live in the mobile
 * client.
 */
export const LOCAL_NEW_SLASH_COMMAND: SlashCommandInfo = {
  name: 'new',
  description: 'Start a new session',
  hints: [],
};

const SLASH_NAME = 'new';
const SLASH_PREFIX_PATTERN = /^\/[\w.-]*$/;
const SLASH_FULL_PATTERN = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/;

/**
 * Reserved commands the mobile client promises to intercept when a remote CLI
 * reports `refresh: 'upgrade-required'`. The live catalog may be empty for an
 * old CLI, so the composer relies on this fixed allowlist rather than the
 * dynamic command list for fail-closed upgrade handling. This set is the
 * explicit mobile promise: any new mobile-reserved slash commands must be
 * added here; do not refactor the SDK to assume this list.
 */
const RESERVED_UPGRADE_REQUIRED_COMMANDS = new Set(['compact', SLASH_NAME]);

type ChatComposerParseContext = {
  hasAttachments: boolean;
  sessionType: ActiveSessionType | null;
  remoteCommandState: RemoteCommandState | null;
};

export type ChatComposerParseResult =
  | { type: 'prompt'; prompt: string }
  | { type: 'command'; command: string; arguments: string }
  | { type: 'create-session' }
  | { type: 'attachment-error' }
  | { type: 'argument-error' }
  | { type: 'upgrade-required'; message: string };

const UPGRADE_REQUIRED_FALLBACK_MESSAGE = 'Please upgrade your CLI to use this command.';

/**
 * Select the slash command catalog the mobile composer should surface.
 *
 * - `cloud-agent` sessions use the live reported catalog verbatim — empty
 *   stays empty and the Cloud Agent defaults live in the worker, not here.
 * - `remote` sessions use the exact live CLI catalog, plus the locally
 *   reserved `/new` command that maps to `createRemoteSession()`. Any
 *   CLI-reported `/new` is stripped first so we never double-list it.
 * - `read-only` and `null` (unresolved) sessions expose no commands.
 *
 * We expose the reserved `/new` even when the remote catalog is empty so
 * users with a freshly-connected remote session can still trigger a new
 * session from the composer.
 */
export function createMobileSlashCommandList(
  sessionType: ActiveSessionType | null,
  availableCommands: SlashCommandInfo[],
  remoteCommandState: RemoteCommandState | null
): SlashCommandInfo[] {
  if (sessionType === 'cloud-agent') {
    return availableCommands;
  }
  if (sessionType !== 'remote' || !remoteCommandState) {
    return [];
  }
  const remoteCommands = remoteCommandState.commands.filter(command => command.name !== SLASH_NAME);
  return [...remoteCommands, LOCAL_NEW_SLASH_COMMAND];
}

/**
 * Returns the input when it can still match a command name, `null` otherwise.
 * Keeping non-candidates collapsed to `null` lets the composer skip
 * re-rendering on every keystroke of ordinary prose.
 */
export function getSlashCommandCandidate(input: string): string | null {
  return SLASH_PREFIX_PATTERN.test(input) ? input : null;
}

/**
 * Return the catalog entries whose name starts with the prefix in `input`.
 * Returns `[]` for anything that is not still a slash-name candidate.
 */
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

function findCommand(commands: SlashCommandInfo[], name: string): SlashCommandInfo | undefined {
  return commands.find(command => command.name === name);
}

/**
 * Classify a composer input into the action the composer should take.
 *
 * Order matters: the upgrade-required short-circuit runs before recognition so
 * that the reserved commands mobile promises to handle (`compact` and `new`)
 * are surfaced to the user when the remote CLI requires an upgrade, instead of
 * silently falling through as ordinary prompts. Unknown slash inputs (`/foo`)
 * still fall through to `prompt` so the user can send arbitrary text the CLI
 * may know about.
 */
export function parseChatComposerSubmission(
  input: string,
  commands: SlashCommandInfo[],
  context: ChatComposerParseContext
): ChatComposerParseResult {
  const trimmed = input.trim();
  const match = SLASH_FULL_PATTERN.exec(trimmed);
  const commandName = match?.[1];
  const argumentsText = match?.[2]?.trim() ?? '';

  if (
    context.sessionType === 'remote' &&
    context.remoteCommandState?.refresh === 'upgrade-required'
  ) {
    if (commandName && RESERVED_UPGRADE_REQUIRED_COMMANDS.has(commandName)) {
      return {
        type: 'upgrade-required',
        message: context.remoteCommandState.message ?? UPGRADE_REQUIRED_FALLBACK_MESSAGE,
      };
    }
    return { type: 'prompt', prompt: trimmed };
  }

  if (commandName === SLASH_NAME && context.sessionType === 'remote') {
    // /new is reserved for remote sessions only.
    if (context.hasAttachments) {
      return { type: 'attachment-error' };
    }
    if (argumentsText.length > 0) {
      return { type: 'argument-error' };
    }
    return { type: 'create-session' };
  }
  // Non-remote /new falls through to the command-or-prompt logic below.

  if (commandName && findCommand(commands, commandName)) {
    if (context.hasAttachments) {
      return { type: 'attachment-error' };
    }
    return { type: 'command', command: commandName, arguments: argumentsText };
  }

  return { type: 'prompt', prompt: trimmed };
}
