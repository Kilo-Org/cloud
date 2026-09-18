/* eslint-disable max-lines -- the suggestion, parse, and description suites share the composer-command fixtures in one file. */
import { afterEach, describe, expect, it } from 'vitest';

import { type SlashCommandInfo } from '@kilocode/cloud-agent-sdk';
import { type RemoteCommandState } from '@kilocode/cloud-agent-sdk/remote-command-catalog';

import {
  createMobileSlashCommandList,
  getLocalClearSlashCommand,
  getLocalExitSlashCommand,
  getLocalNewSlashCommand,
  getSlashCommandCandidate,
  getSlashCommandDescription,
  getSlashCommandSuggestions,
  isCatalogueSlashCommand,
  parseChatComposerSubmission,
} from '@/components/agents/chat-composer-slash-commands';
import { i18n } from '@/i18n';
import en from '@/i18n/locales/en.json';

const COMPACT: SlashCommandInfo = { name: 'compact', description: 'Compact', hints: [] };
const REVIEW: SlashCommandInfo = { name: 'review', description: 'Review', hints: [] };
const GOAL: SlashCommandInfo = { name: 'goal', description: 'Goal', hints: [] };
const SAMPLE_COMMANDS: SlashCommandInfo[] = [COMPACT, REVIEW];

function remoteState(overrides: Partial<RemoteCommandState> = {}): RemoteCommandState {
  return {
    ownerConnectionId: 'conn-1',
    refresh: 'idle',
    commands: SAMPLE_COMMANDS,
    ...overrides,
  };
}

describe('createMobileSlashCommandList', () => {
  it('returns the live CLI catalog with reserved /new injected', () => {
    const list = createMobileSlashCommandList('remote', SAMPLE_COMMANDS, remoteState());
    expect(list).toEqual([...SAMPLE_COMMANDS, getLocalNewSlashCommand()]);
  });

  it('strips any CLI-reported /new and /clear before injecting the local reserved ones', () => {
    const list = createMobileSlashCommandList(
      'remote',
      [COMPACT, getLocalNewSlashCommand(), getLocalClearSlashCommand()],
      remoteState({
        commands: [COMPACT, getLocalNewSlashCommand(), getLocalClearSlashCommand()],
      })
    );
    expect(list.filter(command => command.name === 'new')).toEqual([getLocalNewSlashCommand()]);
    expect(list.filter(command => command.name === 'clear')).toEqual([]);
    expect(list[0]).toBe(COMPACT);
  });

  it('still exposes /new when the remote catalog is empty but the session is live', () => {
    const list = createMobileSlashCommandList(
      'remote',
      [],
      remoteState({ commands: [], refresh: 'idle' })
    );
    expect(list).toEqual([getLocalNewSlashCommand()]);
  });

  it('exposes reserved /new when the remote catalog is empty and upgrade-required', () => {
    const list = createMobileSlashCommandList(
      'remote',
      [],
      remoteState({ commands: [], refresh: 'upgrade-required', message: 'Please upgrade your CLI' })
    );
    expect(list).toEqual([getLocalNewSlashCommand()]);
    expect(list.some(command => command.name === 'compact')).toBe(false);
  });

  it('keeps /new available under upgrade-required', () => {
    const list = createMobileSlashCommandList(
      'remote',
      SAMPLE_COMMANDS,
      remoteState({ refresh: 'upgrade-required', message: 'Please upgrade' })
    );
    expect(list.map(command => command.name)).toEqual(['compact', 'review', 'new']);
  });

  it('returns the live catalog verbatim for cloud-agent sessions without injecting /new', () => {
    const list = createMobileSlashCommandList('cloud-agent', SAMPLE_COMMANDS, null);
    expect(list).toBe(SAMPLE_COMMANDS);
  });

  it('does not strip a CLI-reported /goal from a remote catalog', () => {
    const list = createMobileSlashCommandList('remote', [GOAL], remoteState({ commands: [GOAL] }));
    expect(list.map(command => command.name)).toEqual(['goal', 'new']);
  });

  it('exposes no commands for read-only, unresolved, or other noninteractive session types', () => {
    expect(createMobileSlashCommandList('read-only', SAMPLE_COMMANDS, null)).toEqual([]);
    expect(createMobileSlashCommandList(null, SAMPLE_COMMANDS, null)).toEqual([]);
  });

  it('includes /new, /exit, /quit, and /clear when canExitSession is true', () => {
    const list = createMobileSlashCommandList(
      'remote',
      SAMPLE_COMMANDS,
      remoteState({ canExitSession: true })
    );
    expect(list.map(command => command.name)).toEqual([
      'compact',
      'review',
      'new',
      'exit',
      'quit',
      'clear',
    ]);
  });
});

describe('getSlashCommandCandidate', () => {
  it('keeps prefix-typed slash inputs that can still match a command', () => {
    expect(getSlashCommandCandidate('/')).toBe('/');
    expect(getSlashCommandCandidate('/re')).toBe('/re');
    expect(getSlashCommandCandidate('/new')).toBe('/new');
  });

  it('collapses prose and any input with arguments or trailing whitespace to null', () => {
    expect(getSlashCommandCandidate('hello')).toBeNull();
    expect(getSlashCommandCandidate('/review main')).toBeNull();
    expect(getSlashCommandCandidate('/review ')).toBeNull();
    expect(getSlashCommandCandidate('')).toBeNull();
  });
});

describe('getSlashCommandSuggestions', () => {
  it('filters the current catalog by the command-name prefix', () => {
    expect(getSlashCommandSuggestions('/re', SAMPLE_COMMANDS)).toEqual([REVIEW]);
  });

  it('returns every command for the empty prefix', () => {
    expect(getSlashCommandSuggestions('/', SAMPLE_COMMANDS)).toEqual(SAMPLE_COMMANDS);
  });

  it('closes after command arguments begin or when input is not slash-prefixed', () => {
    expect(getSlashCommandSuggestions('/review main', SAMPLE_COMMANDS)).toEqual([]);
    expect(getSlashCommandSuggestions('review', SAMPLE_COMMANDS)).toEqual([]);
  });
});

describe('parseChatComposerSubmission — happy path', () => {
  it('parses a recognized command and preserves its argument text', () => {
    expect(
      parseChatComposerSubmission('  /review   main  branch  ', SAMPLE_COMMANDS, {
        hasAttachments: false,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'command', command: 'review', arguments: 'main  branch' });
  });

  it('preserves empty arguments for a command with no trailing args', () => {
    expect(
      parseChatComposerSubmission('/compact', SAMPLE_COMMANDS, {
        hasAttachments: false,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'command', command: 'compact', arguments: '' });
  });

  it('routes /new with no arguments to create-session', () => {
    expect(
      parseChatComposerSubmission('/new', [...SAMPLE_COMMANDS, getLocalNewSlashCommand()], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'create-session' });
  });

  it('keeps an unknown slash-prefixed input as a prompt', () => {
    expect(
      parseChatComposerSubmission(' /unknown keep this ', SAMPLE_COMMANDS, {
        hasAttachments: true,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'prompt', prompt: '/unknown keep this' });
  });
});

describe('parseChatComposerSubmission — attachment errors', () => {
  it('rejects attachments only for recognized commands', () => {
    expect(
      parseChatComposerSubmission('/compact', SAMPLE_COMMANDS, {
        hasAttachments: true,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'attachment-error' });
  });

  it('rejects attachments for /new create-session', () => {
    expect(
      parseChatComposerSubmission('/new', [...SAMPLE_COMMANDS, getLocalNewSlashCommand()], {
        hasAttachments: true,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'attachment-error' });
  });

  it('does not flag attachments for an unknown slash command (it stays a prompt)', () => {
    expect(
      parseChatComposerSubmission('/not-a-command', SAMPLE_COMMANDS, {
        hasAttachments: true,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'prompt', prompt: '/not-a-command' });
  });
});

describe('parseChatComposerSubmission — argument errors', () => {
  it('rejects /new with any argument text', () => {
    expect(
      parseChatComposerSubmission('/new extra', [...SAMPLE_COMMANDS, getLocalNewSlashCommand()], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'argument-error', message: '/new does not take arguments.' });
  });
});

describe('parseChatComposerSubmission — upgrade-required', () => {
  it('returns upgrade-required for any known remote command when the CLI must upgrade', () => {
    expect(
      parseChatComposerSubmission('/compact', SAMPLE_COMMANDS, {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'upgrade-required', message: 'Please upgrade your CLI' });
  });

  it('returns upgrade-required for the reserved /new command when the CLI must upgrade', () => {
    expect(
      parseChatComposerSubmission('/new', [...SAMPLE_COMMANDS, getLocalNewSlashCommand()], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'upgrade-required', message: 'Please upgrade your CLI' });
  });

  it('keeps unknown slash commands as prompts even when the CLI must upgrade', () => {
    expect(
      parseChatComposerSubmission('/foo', SAMPLE_COMMANDS, {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'prompt', prompt: '/foo' });
  });

  it('returns upgrade-required for the reserved /compact command even when the remote catalog is empty', () => {
    expect(
      parseChatComposerSubmission('/compact', [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          commands: [],
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'upgrade-required', message: 'Please upgrade your CLI' });
  });

  it('returns upgrade-required for the reserved /new command even when the remote catalog is empty', () => {
    expect(
      parseChatComposerSubmission('/new', [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          commands: [],
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'upgrade-required', message: 'Please upgrade your CLI' });
  });

  it('keeps unknown slash commands as prompts with an empty catalog when the CLI must upgrade', () => {
    expect(
      parseChatComposerSubmission('/foo', [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          commands: [],
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'prompt', prompt: '/foo' });
  });
});

describe('parseChatComposerSubmission — non-remote sessions ignore the remote state', () => {
  it('does not raise upgrade-required for cloud-agent sessions even if a remote state is passed', () => {
    expect(
      parseChatComposerSubmission('/compact', SAMPLE_COMMANDS, {
        hasAttachments: false,
        sessionType: 'cloud-agent',
        remoteCommandState: remoteState({ refresh: 'upgrade-required' }),
      })
    ).toEqual({ type: 'command', command: 'compact', arguments: '' });
  });
});

describe('catalogueDescription marker', () => {
  it('marks the reserved builders and leaves runtime commands unmarked', () => {
    expect(getLocalNewSlashCommand().catalogueDescription).toBe(true);
    expect(getLocalExitSlashCommand().catalogueDescription).toBe(true);
    expect(getLocalClearSlashCommand().catalogueDescription).toBe(true);
    const runtime = createMobileSlashCommandList('cloud-agent', SAMPLE_COMMANDS, null);
    expect(runtime.every(command => command.catalogueDescription === undefined)).toBe(true);
    const suggestions = getSlashCommandSuggestions(
      '/ne',
      createMobileSlashCommandList('remote', SAMPLE_COMMANDS, remoteState())
    );
    expect(suggestions[0]?.catalogueDescription).toBe(true);
  });
});

describe('getSlashCommandDescription', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('keeps the description a catalog entry reports when it reuses a built-in command name', () => {
    // A repository command file or an MCP prompt can carry a built-in name,
    // so the name alone must not pull the row into the catalogue.
    for (const [name, description] of [
      ['review', 'review my style guide'],
      ['init', 'bootstrap this repository'],
      ['compact', 'shrink my notes'],
      ['resume-claude', 'continue my Claude transcript'],
    ] as const) {
      expect(getSlashCommandDescription({ name, description, hints: [] })).toBe(description);
    }
  });

  it('keeps an external entry that reuses a built-in name in a non-English locale', async () => {
    await i18n.changeLanguage('de');
    expect(
      getSlashCommandDescription({
        name: 'review',
        description: 'review my style guide',
        hints: [],
      })
    ).toBe('review my style guide');
  });

  it('resolves a built-in entry that reports the catalog source string', () => {
    expect(
      getSlashCommandDescription({
        name: 'goal',
        description: en.agentChat.slashCommands.goalDescription,
        hints: [],
      })
    ).toBe('Keep working toward a session goal. /goal <objective> or pause, resume, clear');
  });

  it('resolves every built-in command name that reports the catalog source string', () => {
    const expected = {
      compact: en.agentChat.slashCommands.compactDescription,
      goal: en.agentChat.slashCommands.goalDescription,
      init: en.agentChat.slashCommands.initDescription,
      'resume-claude': en.agentChat.slashCommands.resumeClaudeDescription,
      'resume-codex': en.agentChat.slashCommands.resumeCodexDescription,
      review: en.agentChat.slashCommands.reviewDescription,
    };
    for (const [name, description] of Object.entries(expected)) {
      expect(getSlashCommandDescription({ name, description, hints: [] })).toBe(description);
    }
  });

  it('localizes a command this client registered, whichever language built it', async () => {
    const command = getLocalNewSlashCommand();
    await i18n.changeLanguage('de');
    i18n.addResource(
      'de',
      'translation',
      'agentChat.slashCommands.startNewSession',
      'Neue Sitzung'
    );
    expect(getSlashCommandDescription(command)).toBe('Neue Sitzung');
    i18n.removeResourceBundle('de', 'translation');
  });

  it('prefers the active language catalog over the built-in English source', async () => {
    await i18n.changeLanguage('de');
    i18n.addResource('de', 'translation', 'agentChat.slashCommands.goalDescription', 'Ziel');
    expect(
      getSlashCommandDescription({
        name: 'goal',
        description: en.agentChat.slashCommands.goalDescription,
        hints: [],
      })
    ).toBe('Ziel');
    i18n.removeResourceBundle('de', 'translation');
  });

  it('keeps the reported description for a command the catalog does not know', () => {
    expect(getSlashCommandDescription({ name: 'help', description: 'Show help', hints: [] })).toBe(
      'Show help'
    );
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
    'keeps the reported description for the inherited Object.prototype name %s',
    name => {
      expect(getSlashCommandDescription({ name, description: 'Repo command', hints: [] })).toBe(
        'Repo command'
      );
    }
  );

  it('returns undefined for an unknown command with no description', () => {
    expect(getSlashCommandDescription({ name: 'help', hints: [] })).toBeUndefined();
  });
});

describe('isCatalogueSlashCommand', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('accounts for a built-in entry that reports the English catalog source string', () => {
    expect(
      isCatalogueSlashCommand({
        name: 'goal',
        description: en.agentChat.slashCommands.goalDescription,
        hints: [],
      })
    ).toBe(true);
  });

  it('accounts for a built-in entry whose reported text matches the source in the English app language', () => {
    // The worker/CLI catalog reports the exact English catalogue strings, so
    // in English the resolved string equals the reported one; the row must
    // still treat it as catalogue copy and keep it out of the gateway.
    expect(
      isCatalogueSlashCommand({
        name: 'review',
        description: en.agentChat.slashCommands.reviewDescription,
        hints: [],
      })
    ).toBe(true);
    expect(
      isCatalogueSlashCommand({
        name: 'compact',
        description: en.agentChat.slashCommands.compactDescription,
        hints: [],
      })
    ).toBe(true);
  });

  it('does not account for an external entry that reuses a built-in name', () => {
    expect(
      isCatalogueSlashCommand({ name: 'review', description: 'review my style guide', hints: [] })
    ).toBe(false);
  });

  it('does not account for a command the catalog does not know', () => {
    expect(isCatalogueSlashCommand({ name: 'mcp-tool', description: 'Run it', hints: [] })).toBe(
      false
    );
  });

  it('accounts for a command this client registered', () => {
    expect(isCatalogueSlashCommand(getLocalNewSlashCommand())).toBe(true);
  });
});
