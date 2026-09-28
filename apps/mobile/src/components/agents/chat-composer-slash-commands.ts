import {
  type ActiveSessionType,
  type SlashCommandCatalogStatus,
  type SlashCommandInfo,
} from '@kilocode/cloud-agent-sdk';
import { type RemoteCommandState } from '@kilocode/cloud-agent-sdk/remote-command-catalog';

import { i18n } from '@/i18n';

/**
 * A slash command the mobile composer may show. `catalogueDescription` marks a
 * description that already comes from the app's i18n catalogue (the reserved
 * local commands), so the suggestion row never sends it to the translation
 * gateway; the CLI-reported commands leave it unset and translate.
 */
export type MobileSlashCommandInfo = SlashCommandInfo & { catalogueDescription?: boolean };

/**
 * A slash command this client registers itself — the mobile-local reserved
 * commands. The client knows the command's origin, so `getSlashCommandDescription`
 * may look its description up by name even though the composer memoizes the
 * list across language changes.
 *
 * A catalog entry cannot carry this flag: the client cannot tell whether an
 * entry named `review` is the built-in command or an external command (a
 * repository command file, an MCP prompt) that reuses the name.
 */
export type BuiltInSlashCommandInfo = MobileSlashCommandInfo & { readonly builtIn: true };

/**
 * Local reserved /new command — surfaced only for remote sessions, never
 * pushed to the CLI. Remote CLIs have no /new (they create sessions through a
 * dedicated control message), so a slash-style "new" must live in the mobile
 * client.
 */
export function getLocalNewSlashCommand(): BuiltInSlashCommandInfo {
  return {
    name: 'new',
    description: i18n.t('agentChat.slashCommands.startNewSession'),
    hints: [],
    catalogueDescription: true,
    builtIn: true,
  };
}

export function getLocalExitSlashCommand(): BuiltInSlashCommandInfo {
  return {
    name: 'exit',
    description: i18n.t('agentChat.slashCommands.exitSession'),
    hints: [],
    catalogueDescription: true,
    builtIn: true,
  };
}

function getLocalQuitSlashCommand(): BuiltInSlashCommandInfo {
  // Inherits `catalogueDescription: true` and `builtIn: true` by spread.
  return { ...getLocalExitSlashCommand(), name: QUIT_COMMAND_NAME };
}

/**
 * Local reserved /clear command — closes the current remote session and
 * opens a new one on the same screen. Capability-gated: the CLI must report
 * `canExitSession === true` because /clear needs both create_session and
 * exit_cli.
 */
export function getLocalClearSlashCommand(): BuiltInSlashCommandInfo {
  return {
    name: 'clear',
    description: i18n.t('agentChat.slashCommands.clearSession'),
    hints: [],
    catalogueDescription: true,
    builtIn: true,
  };
}

const NEW_COMMAND_NAME = 'new';
const EXIT_COMMAND_NAME = 'exit';
const QUIT_COMMAND_NAME = 'quit';
const CLEAR_COMMAND_NAME = 'clear';
const GOAL_COMMAND_NAME = 'goal';
const LOCAL_COMMAND_NAMES = new Set([
  NEW_COMMAND_NAME,
  EXIT_COMMAND_NAME,
  CLEAR_COMMAND_NAME,
  QUIT_COMMAND_NAME,
  'q',
]);

/**
 * Catalog key for every slash-command name the composer's menu can show: the
 * worker catalog (`goal`, `init`, `resume-claude`, `resume-codex`, `review`),
 * the session command (`compact`), and the mobile-local reserved commands
 * (`new`, `exit`, `quit`, `clear`). `quit` shares `/exit`'s key. A name here is
 * looked up only for a command this client registered or for a catalog entry
 * that reports the built-in English source string; see
 * `getSlashCommandDescription`.
 */
const SLASH_COMMAND_DESCRIPTION_KEYS = {
  compact: 'agentChat.slashCommands.compactDescription',
  goal: 'agentChat.slashCommands.goalDescription',
  init: 'agentChat.slashCommands.initDescription',
  'resume-claude': 'agentChat.slashCommands.resumeClaudeDescription',
  'resume-codex': 'agentChat.slashCommands.resumeCodexDescription',
  review: 'agentChat.slashCommands.reviewDescription',
  new: 'agentChat.slashCommands.startNewSession',
  exit: 'agentChat.slashCommands.exitSession',
  quit: 'agentChat.slashCommands.exitSession',
  clear: 'agentChat.slashCommands.clearSession',
} as const satisfies Record<string, string>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  // The key is an untrusted command name, so match own properties only:
  // inherited members like 'constructor' would otherwise resolve to a
  // function and get handed to i18n.t instead of falling back to the
  // reported description.
  return Object.hasOwn(dictionary, key)
    ? (dictionary as Readonly<Record<string, V | undefined>>)[key]
    : undefined;
}

/** True for a command this client created, which is always the built-in one. */
function isBuiltInSlashCommand(command: SlashCommandInfo): boolean {
  // The wire type has no origin field, so the flag lives on the objects this
  // module creates and is read back structurally.
  return (command as Partial<BuiltInSlashCommandInfo>).builtIn === true;
}

/**
 * True when the catalogue resolves this command's name to its own description.
 *
 * A name alone is not proof that a row is the built-in command: the worker
 * catalog, a repository command file, and an MCP prompt can all report a
 * built-in name with their own description, and the CLI replaces the built-in
 * entry with that command. Only a command this client registered, or a catalog
 * entry that reports the built-in English source string, is accounted for.
 */
function hasCatalogueDescription(command: SlashCommandInfo): boolean {
  const key = lookup(SLASH_COMMAND_DESCRIPTION_KEYS, command.name);
  if (key === undefined) {
    return false;
  }
  return isBuiltInSlashCommand(command) || command.description === i18n.t(key, { lng: 'en' });
}

/**
 * True when the app catalogue accounts for this command's description, i.e.
 * when `getSlashCommandDescription` resolves it from the catalogue instead of
 * returning the reported text. The `catalogueDescription` marker covers the
 * commands this client registered; see `hasCatalogueDescription` for a catalog
 * entry.
 *
 * A catalogue-accounted row is already in the app language, so the slash menu
 * must not send it to the translation gateway — including when the app language
 * is English, where the resolved string equals the reported English source.
 */
export function isCatalogueSlashCommand(command: SlashCommandInfo): boolean {
  return (
    (command as Partial<MobileSlashCommandInfo>).catalogueDescription === true ||
    hasCatalogueDescription(command)
  );
}

/**
 * Resolve a command's description from the active catalog so it follows the
 * app language. A command the catalogue does not account for keeps the
 * description it reports; a command it does account for resolves to its
 * catalogue entry.
 */
export function getSlashCommandDescription(command: SlashCommandInfo): string | undefined {
  const key = lookup(SLASH_COMMAND_DESCRIPTION_KEYS, command.name);
  return key !== undefined && hasCatalogueDescription(command) ? i18n.t(key) : command.description;
}

const SLASH_PREFIX_PATTERN = /^\/[\w.-]*$/;
const SLASH_FULL_PATTERN = /^\/([\w.-]+)(?:\s+([\s\S]*))?$/;

/**
 * Reserved commands the mobile client promises to intercept when a remote CLI
 * reports `refresh: 'upgrade-required'`. The live catalog may be empty for an
 * old CLI, so the composer relies on this fixed allowlist rather than the
 * dynamic command list for fail-closed upgrade handling. This set is the
 * explicit mobile promise: any new mobile-reserved slash commands must be
 * added here; do not refactor the SDK to assume this list.
 *
 * `/clear` is intentionally gated — it needs both create_session and
 * exit_cli and must surface the upgrade message instead of falling through
 * as a prompt.
 *
 * `/goal ...` is included so that on a remote CLI that reports
 * `refresh: 'upgrade-required'` the mobile composer returns the upgrade
 * message instead of forwarding goal text as an ordinary prompt.
 */
const RESERVED_UPGRADE_REQUIRED_COMMANDS = new Set([
  'compact',
  NEW_COMMAND_NAME,
  EXIT_COMMAND_NAME,
  QUIT_COMMAND_NAME,
  CLEAR_COMMAND_NAME,
  GOAL_COMMAND_NAME,
]);

type ChatComposerParseContext = {
  hasAttachments: boolean;
  sessionType: ActiveSessionType | null;
  remoteCommandState: RemoteCommandState | null;
};

export type ChatComposerParseResult =
  | { type: 'prompt'; prompt: string }
  | { type: 'command'; command: string; arguments: string }
  | { type: 'create-session' }
  | { type: 'exit-session' }
  | { type: 'restart-session' }
  | { type: 'goal-compose' }
  | { type: 'attachment-error' }
  | { type: 'argument-error'; message: string }
  | { type: 'upgrade-required'; message: string };

/**
 * Select the slash command catalog the mobile composer should surface.
 *
 * - `cloud-agent` sessions use the live reported catalog verbatim — empty
 *   stays empty and the Cloud Agent defaults live in the worker, not here.
 * - `remote` sessions strip CLI-reported `new`, `exit`, `quit`, `q`, and
 *   `clear`, then append the locally reserved `/new`, capability-gated local
 *   `/exit`, its `/quit` alias, and `/clear` when the live catalog advertises
 *   `canExitSession: true`.
 * - `read-only` and `null` (unresolved) sessions expose no commands.
 *
 * The `/exit`, `/quit`, and `/clear` suggestions are gated on `canExitSession === true`
 * rather than the synthetic `exit` command presence, so an old / unknown CLI
 * that reports a catalog but lacks the safe-detach capability never advertises
 * the actions. `canExitSession === undefined` (old CLI) and
 * `canExitSession === false` (CLI explicitly opts out) both fail closed.
 */
export function createMobileSlashCommandList(
  sessionType: ActiveSessionType | null,
  availableCommands: SlashCommandInfo[],
  remoteCommandState: RemoteCommandState | null
): MobileSlashCommandInfo[] {
  if (sessionType === 'cloud-agent') {
    return availableCommands;
  }
  if (sessionType !== 'remote' || !remoteCommandState) {
    return [];
  }
  const supportsExit = remoteCommandState.canExitSession === true;
  const remoteCommands = remoteCommandState.commands.filter(
    command => !LOCAL_COMMAND_NAMES.has(command.name)
  );
  return [
    ...remoteCommands,
    getLocalNewSlashCommand(),
    ...(supportsExit
      ? [getLocalExitSlashCommand(), getLocalQuitSlashCommand(), getLocalClearSlashCommand()]
      : []),
  ];
}

/**
 * The notice the open slash menu shows for the catalog the wrapper sent, or
 * `null` when there is nothing to say.
 *
 * The wrapper bounds the catalog to the shared 256-command / 512 KiB limits and
 * never truncates a skill row, so two different things need saying: rows were
 * dropped (`dropped`), or the rows kept are still over a bound because the
 * skill rows alone are over it (`dropped === 0` with `overLimit`). An
 * over-limit catalog that dropped nothing is complete, so it must not claim
 * that commands are hidden.
 */
export function getSlashCommandCatalogNotice(
  status: SlashCommandCatalogStatus | null | undefined
): string | null {
  if (!status) {
    return null;
  }
  if (status.dropped > 0) {
    return i18n.t('agentChat.slashCommands.catalogFull');
  }
  return status.overLimit ? i18n.t('agentChat.slashCommands.catalogOverLimit') : null;
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
 * True while `input` is still the `/goal` compose draft (bare `/goal` or
 * `/goal <objective>`). The composer uses this to keep its goal compose mode
 * alive as the user types the objective and to drop it the moment the draft is
 * no longer about the goal command.
 */
export function isGoalCommandDraft(input: string): boolean {
  return /^\/goal(?:\s|$)/.test(input);
}

/**
 * Return the catalog entries whose name starts with the prefix in `input`.
 * Returns `[]` for anything that is not still a slash-name candidate.
 */
export function getSlashCommandSuggestions(
  input: string,
  commands: MobileSlashCommandInfo[]
): MobileSlashCommandInfo[] {
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
 * Order matters:
 * 1. The upgrade-required short-circuit runs before recognition so that
 *    the reserved commands mobile promises to handle (`compact`, `new`,
 *    `exit`, `quit`, and `clear`) are surfaced when the remote CLI requires an
 *    upgrade, instead of silently falling through as ordinary prompts.
 *    Unknown slash inputs (`/foo`) still fall through to `prompt` so the
 *    user can send arbitrary text the CLI may know about.
 *
 * The `/exit`, `/quit`, and `/clear` interceptions are also capability-gated: the
 * parser rejects the exact-typed `/exit`, `/quit`, or `/clear` with an upgrade-required
 * message when the live remote catalog lacks `canExitSession === true`. That
 * is the same fail-closed gate the suggestion list enforces, and it runs even
 * when the suggestion list omits the command (e.g. an empty catalog) so the
 * composer never sends a gated command as a plain prompt to a CLI that does
 * not advertise safe session detach.
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
        message:
          context.remoteCommandState.message ??
          i18n.t('agentChat.slashCommands.upgradeRequiredFallback'),
      };
    }
    return { type: 'prompt', prompt: trimmed };
  }

  if (commandName === NEW_COMMAND_NAME && context.sessionType === 'remote') {
    // /new is reserved for remote sessions only.
    if (context.hasAttachments) {
      return { type: 'attachment-error' };
    }
    if (argumentsText.length > 0) {
      return {
        type: 'argument-error',
        message: i18n.t('agentChat.slashCommands.argumentError', {
          command: `/${NEW_COMMAND_NAME}`,
        }),
      };
    }
    return { type: 'create-session' };
  }
  // Non-remote /new falls through to the command-or-prompt logic below.

  if (
    (commandName === EXIT_COMMAND_NAME || commandName === QUIT_COMMAND_NAME) &&
    context.sessionType === 'remote'
  ) {
    if (context.remoteCommandState?.canExitSession !== true) {
      // Fail-closed: never let an unsupported /exit or /quit leak through as a plain
      // prompt, regardless of whether the suggestion list exposes the
      // command. Use the CLI-supplied upgrade message when present so the
      // user sees the same copy the rest of the upgrade-required surface
      // shows; fall back to a copy that names the capability gap.
      return {
        type: 'upgrade-required',
        message:
          context.remoteCommandState?.message ??
          i18n.t('agentChat.slashCommands.exitCapabilityUnavailable'),
      };
    }
    if (context.hasAttachments) {
      return { type: 'attachment-error' };
    }
    if (argumentsText.length > 0) {
      return {
        type: 'argument-error',
        message: i18n.t('agentChat.slashCommands.argumentError', {
          command: `/${commandName}`,
        }),
      };
    }
    return { type: 'exit-session' };
  }

  if (commandName === CLEAR_COMMAND_NAME && context.sessionType === 'remote') {
    // /clear ends this session and opens a new one, so it needs both
    // create_session and exit_cli. Fail closed on the same capability the
    // /exit gate uses; an old CLI cannot honour the new meaning.
    if (context.remoteCommandState?.canExitSession !== true) {
      return {
        type: 'upgrade-required',
        message:
          context.remoteCommandState?.message ??
          i18n.t('agentChat.slashCommands.clearCapabilityUnavailable'),
      };
    }
    if (context.hasAttachments) {
      return { type: 'attachment-error' };
    }
    if (argumentsText.length > 0) {
      return {
        type: 'argument-error',
        message: i18n.t('agentChat.slashCommands.argumentError', {
          command: `/${CLEAR_COMMAND_NAME}`,
        }),
      };
    }
    return { type: 'restart-session' };
  }

  if (
    commandName === GOAL_COMMAND_NAME &&
    (context.sessionType === 'remote' || context.sessionType === 'cloud-agent')
  ) {
    // /goal is only supported when the session's catalog advertises it. Fail
    // closed on a session that does not, so goal text is never sent as
    // ordinary chat; the existing fail-closed copy is reused so no new i18n
    // key is introduced. `null` and `read-only` sessions are excluded above
    // and keep their existing prompt behavior.
    if (!findCommand(commands, GOAL_COMMAND_NAME)) {
      return {
        type: 'upgrade-required',
        message: i18n.t('agentChat.slashCommands.upgradeRequiredFallback'),
      };
    }
    if (context.hasAttachments) {
      return { type: 'attachment-error' };
    }
    if (argumentsText === '') {
      // Bare `/goal` enters compose mode; selecting `/goal` from the
      // suggestion list inserts `/goal ` and lands here.
      return { type: 'goal-compose' };
    }
    return { type: 'command', command: GOAL_COMMAND_NAME, arguments: argumentsText };
  }

  if (commandName && findCommand(commands, commandName)) {
    if (context.hasAttachments) {
      return { type: 'attachment-error' };
    }
    return { type: 'command', command: commandName, arguments: argumentsText };
  }

  return { type: 'prompt', prompt: trimmed };
}
