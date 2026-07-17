import { describe, expect, it } from 'vitest';

import { type SlashCommandInfo } from 'cloud-agent-sdk';
import { type RemoteCommandState } from 'cloud-agent-sdk/remote-command-catalog';

import {
  createMobileSlashCommandList,
  getSlashCommandCandidate,
  getSlashCommandSuggestions,
  LOCAL_NEW_SLASH_COMMAND,
  parseChatComposerSubmission,
} from '@/components/agents/chat-composer-slash-commands';

const COMPACT: SlashCommandInfo = { name: 'compact', description: 'Compact', hints: [] };
const REVIEW: SlashCommandInfo = { name: 'review', description: 'Review', hints: [] };
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
  it('returns the live CLI catalog verbatim for remote sessions, with the reserved /new injected', () => {
    const list = createMobileSlashCommandList('remote', SAMPLE_COMMANDS, remoteState());
    expect(list).toEqual([...SAMPLE_COMMANDS, LOCAL_NEW_SLASH_COMMAND]);
  });

  it('strips any CLI-reported /new before injecting the local reserved one', () => {
    const list = createMobileSlashCommandList(
      'remote',
      [COMPACT, LOCAL_NEW_SLASH_COMMAND],
      remoteState()
    );
    expect(list.filter(command => command.name === 'new')).toEqual([LOCAL_NEW_SLASH_COMMAND]);
    expect(list[0]).toBe(COMPACT);
  });

  it('still exposes /new when the remote catalog is empty but the session is live', () => {
    const list = createMobileSlashCommandList(
      'remote',
      [],
      remoteState({ commands: [], refresh: 'idle' })
    );
    expect(list).toEqual([LOCAL_NEW_SLASH_COMMAND]);
  });

  it('exposes only the reserved /new command when the remote catalog is empty and upgrade-required', () => {
    const list = createMobileSlashCommandList(
      'remote',
      [],
      remoteState({ commands: [], refresh: 'upgrade-required', message: 'Please upgrade your CLI' })
    );
    expect(list).toEqual([LOCAL_NEW_SLASH_COMMAND]);
    expect(list.some(command => command.name === 'compact')).toBe(false);
  });

  it('keeps /new available under an upgrade-required refresh so the user gets a clear upgrade message instead of a silent prompt', () => {
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

  it('exposes no commands for read-only, unresolved, or other noninteractive session types', () => {
    expect(createMobileSlashCommandList('read-only', SAMPLE_COMMANDS, null)).toEqual([]);
    expect(createMobileSlashCommandList(null, SAMPLE_COMMANDS, null)).toEqual([]);
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
      parseChatComposerSubmission('/new', [...SAMPLE_COMMANDS, LOCAL_NEW_SLASH_COMMAND], {
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
      parseChatComposerSubmission('/new', [...SAMPLE_COMMANDS, LOCAL_NEW_SLASH_COMMAND], {
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
      parseChatComposerSubmission('/new extra', [...SAMPLE_COMMANDS, LOCAL_NEW_SLASH_COMMAND], {
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
      parseChatComposerSubmission('/new', [...SAMPLE_COMMANDS, LOCAL_NEW_SLASH_COMMAND], {
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
