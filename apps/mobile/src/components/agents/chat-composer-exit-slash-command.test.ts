import { describe, expect, it } from 'vitest';

import { type SlashCommandInfo } from '@kilocode/cloud-agent-sdk';
import { type RemoteCommandState } from '@kilocode/cloud-agent-sdk/remote-command-catalog';

import {
  createMobileSlashCommandList,
  getLocalClearSlashCommand,
  getLocalExitSlashCommand,
  getLocalNewSlashCommand,
  getSlashCommandCandidate,
  getSlashCommandSuggestions,
  parseChatComposerSubmission,
} from '@/components/agents/chat-composer-slash-commands';

const COMPACT: SlashCommandInfo = { name: 'compact', description: 'Compact', hints: [] };
const EXIT: SlashCommandInfo = { name: 'exit', description: 'Remote exit', hints: ['force'] };
const QUIT: SlashCommandInfo = { name: 'quit', description: 'Quit alias', hints: [] };
const Q: SlashCommandInfo = { name: 'q', description: 'Short quit alias', hints: [] };

function localQuitCommand(): SlashCommandInfo {
  return { ...getLocalExitSlashCommand(), name: 'quit' };
}

function remoteState(overrides: Partial<RemoteCommandState> = {}): RemoteCommandState {
  return {
    ownerConnectionId: 'conn-1',
    refresh: 'idle',
    commands: [COMPACT, EXIT],
    canExitSession: true,
    ...overrides,
  };
}

describe('remote /exit and /quit command list — capability gate', () => {
  it('strips reserved CLI entries and appends local /quit immediately after /exit when supported', () => {
    const commands = [COMPACT, getLocalNewSlashCommand(), EXIT, QUIT, Q];
    const list = createMobileSlashCommandList('remote', commands, remoteState({ commands }));

    expect(list).toEqual([
      COMPACT,
      getLocalNewSlashCommand(),
      getLocalExitSlashCommand(),
      localQuitCommand(),
      getLocalClearSlashCommand(),
    ]);
    expect(list.filter(command => command.name === 'new')).toHaveLength(1);
    expect(list.filter(command => command.name === 'exit')).toHaveLength(1);
    expect(list.filter(command => command.name === 'quit')).toHaveLength(1);
    expect(list.filter(command => command.name === 'clear')).toHaveLength(1);
    expect(list.some(command => command.name === 'q')).toBe(false);
  });

  it.each(['/q', '/qu', '/qui', '/quit'])('autocompletes %s to the local exit alias', input => {
    const list = createMobileSlashCommandList('remote', [], remoteState({ commands: [] }));
    expect(getSlashCommandCandidate(input)).toBe(input);
    expect(getSlashCommandSuggestions(input, list)).toEqual([localQuitCommand()]);
    expect(getSlashCommandSuggestions('/', list)).toEqual([
      getLocalNewSlashCommand(),
      getLocalExitSlashCommand(),
      localQuitCommand(),
      getLocalClearSlashCommand(),
    ]);
  });

  it.each([undefined, false])(
    'omits local exit actions when canExitSession is %s',
    canExitSession => {
      const list = createMobileSlashCommandList(
        'remote',
        [COMPACT, EXIT, QUIT, Q],
        remoteState({ commands: [COMPACT, EXIT, QUIT, Q], canExitSession })
      );
      expect(list).toEqual([COMPACT, getLocalNewSlashCommand()]);
      expect(getSlashCommandSuggestions('/qu', list)).toEqual([]);
    }
  );

  it('shows no local aliases when the remote state is unresolved', () => {
    expect(createMobileSlashCommandList('remote', [EXIT, QUIT], null)).toEqual([]);
  });

  it('omits /exit and /clear when the live catalog advertises canonical exit but omits canExitSession', () => {
    const list = createMobileSlashCommandList(
      'remote',
      [COMPACT, EXIT],
      remoteState({ commands: [COMPACT, EXIT], canExitSession: undefined })
    );
    expect(list.map(command => command.name)).toEqual(['compact', 'new']);
    expect(list.some(command => command.name === 'exit')).toBe(false);
    expect(list.some(command => command.name === 'clear')).toBe(false);
  });

  it('keeps /exit and /quit available under upgrade-required when canExitSession is true', () => {
    expect(
      createMobileSlashCommandList(
        'remote',
        [],
        remoteState({ commands: [EXIT], refresh: 'upgrade-required', message: 'Please upgrade' })
      )
    ).toEqual([
      getLocalNewSlashCommand(),
      getLocalExitSlashCommand(),
      localQuitCommand(),
      getLocalClearSlashCommand(),
    ]);
  });
});

describe.each(['exit', 'quit'])('remote /%s parser — shared exit behavior', command => {
  it.each(['', ' ', '\n\t'])('routes the command with trailing %j to exit-session', suffix => {
    expect(
      parseChatComposerSubmission(
        `  /${command}${suffix}`,
        [getLocalNewSlashCommand(), getLocalExitSlashCommand()],
        {
          hasAttachments: false,
          sessionType: 'remote',
          remoteCommandState: remoteState(),
        }
      )
    ).toEqual({ type: 'exit-session' });
  });

  it('fails closed when canExitSession is undefined, even with the command in the list', () => {
    expect(
      parseChatComposerSubmission(`/${command}`, [getLocalExitSlashCommand(), localQuitCommand()], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({ canExitSession: undefined }),
      })
    ).toEqual({ type: 'upgrade-required', message: 'Update your CLI to exit the session.' });
  });

  it('fails closed when canExitSession is false', () => {
    expect(
      parseChatComposerSubmission(`/${command}`, [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({ canExitSession: false }),
      })
    ).toEqual({ type: 'upgrade-required', message: 'Update your CLI to exit the session.' });
  });

  it('prefers the CLI-supplied upgrade message when canExitSession is missing', () => {
    expect(
      parseChatComposerSubmission(`/${command}`, [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          commands: [],
          canExitSession: undefined,
          message: 'Custom CLI upgrade message',
        }),
      })
    ).toEqual({ type: 'upgrade-required', message: 'Custom CLI upgrade message' });
  });

  it('rejects attachments with the command attachment error', () => {
    expect(
      parseChatComposerSubmission(`/${command}`, [], {
        hasAttachments: true,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'attachment-error' });
  });

  it('rejects arguments with command-specific feedback data', () => {
    expect(
      parseChatComposerSubmission(`/${command} now`, [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'argument-error', message: '/exit does not take arguments.' });
  });

  it.each(['/q', '/quitter', '/quit-now', '/QUIT'])(
    'keeps unreserved %s as an ordinary prompt',
    input => {
      expect(
        parseChatComposerSubmission(
          input,
          [getLocalNewSlashCommand(), getLocalExitSlashCommand()],
          {
            hasAttachments: false,
            sessionType: 'remote',
            remoteCommandState: remoteState({ commands: [EXIT, QUIT, Q] }),
          }
        )
      ).toEqual({ type: 'prompt', prompt: input });
    }
  );

  it('returns upgrade-required with an empty catalog under upgrade-required', () => {
    expect(
      parseChatComposerSubmission(`/${command}`, [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          commands: [],
          canExitSession: undefined,
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'upgrade-required', message: 'Please upgrade your CLI' });
  });

  it.each(['/q', '/quitter'])('keeps unreserved %s as a prompt when upgrade is required', input => {
    expect(
      parseChatComposerSubmission(input, [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          commands: [],
          canExitSession: undefined,
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'prompt', prompt: input });
  });

  it.each(['cloud-agent', 'read-only', null] as const)(
    'does not reserve the command for %s sessions',
    sessionType => {
      expect(
        parseChatComposerSubmission(`/${command}`, [], {
          hasAttachments: false,
          sessionType,
          remoteCommandState: remoteState(),
        })
      ).toEqual({ type: 'prompt', prompt: `/${command}` });
    }
  );

  it('fails closed when remote state has not resolved', () => {
    expect(
      parseChatComposerSubmission(`/${command}`, [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'upgrade-required', message: 'Update your CLI to exit the session.' });
  });

  it('uses the same fallback upgrade copy before argument or attachment validation', () => {
    const context = {
      hasAttachments: true,
      sessionType: 'remote' as const,
      remoteCommandState: remoteState({ refresh: 'upgrade-required', commands: [] }),
    };
    const expected = parseChatComposerSubmission('/exit', [], context);
    expect(expected.type).toBe('upgrade-required');
    expect(parseChatComposerSubmission(`/${command} now`, [], context)).toEqual(expected);
  });
});
