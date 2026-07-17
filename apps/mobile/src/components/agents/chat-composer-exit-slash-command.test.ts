import { describe, expect, it } from 'vitest';

import { type SlashCommandInfo } from 'cloud-agent-sdk';
import { type RemoteCommandState } from 'cloud-agent-sdk/remote-command-catalog';

import {
  createMobileSlashCommandList,
  LOCAL_EXIT_SLASH_COMMAND,
  LOCAL_NEW_SLASH_COMMAND,
  parseChatComposerSubmission,
} from '@/components/agents/chat-composer-slash-commands';

const COMPACT: SlashCommandInfo = { name: 'compact', description: 'Compact', hints: [] };
const EXIT: SlashCommandInfo = { name: 'exit', description: 'Remote exit', hints: ['force'] };
const QUIT: SlashCommandInfo = { name: 'quit', description: 'Quit alias', hints: [] };
const Q: SlashCommandInfo = { name: 'q', description: 'Short quit alias', hints: [] };

function remoteState(overrides: Partial<RemoteCommandState> = {}): RemoteCommandState {
  return {
    ownerConnectionId: 'conn-1',
    refresh: 'idle',
    commands: [COMPACT, EXIT],
    ...overrides,
  };
}

describe('remote /exit command list', () => {
  it('strips reserved CLI entries and appends canonical local /new and /exit without aliases', () => {
    const commands = [COMPACT, LOCAL_NEW_SLASH_COMMAND, EXIT, QUIT, Q];
    const list = createMobileSlashCommandList('remote', commands, remoteState({ commands }));

    expect(list).toEqual([COMPACT, LOCAL_NEW_SLASH_COMMAND, LOCAL_EXIT_SLASH_COMMAND]);
    expect(list.filter(command => command.name === 'new')).toHaveLength(1);
    expect(list.filter(command => command.name === 'exit')).toHaveLength(1);
    expect(list.some(command => command.name === 'quit' || command.name === 'q')).toBe(false);
  });

  it('omits local /exit when the current live catalog has no canonical exit capability', () => {
    expect(
      createMobileSlashCommandList('remote', [COMPACT, EXIT], remoteState({ commands: [COMPACT] }))
    ).toEqual([COMPACT, LOCAL_NEW_SLASH_COMMAND]);
  });

  it('keeps local /exit available during upgrade-required when the live catalog advertises it', () => {
    expect(
      createMobileSlashCommandList(
        'remote',
        [],
        remoteState({ commands: [EXIT], refresh: 'upgrade-required', message: 'Please upgrade' })
      )
    ).toEqual([LOCAL_NEW_SLASH_COMMAND, LOCAL_EXIT_SLASH_COMMAND]);
  });
});

describe('remote /exit parser', () => {
  it('routes exact remote /exit to exit-cli', () => {
    expect(
      parseChatComposerSubmission('/exit', [LOCAL_NEW_SLASH_COMMAND, LOCAL_EXIT_SLASH_COMMAND], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'exit-cli' });
  });

  it('rejects attachments with the command attachment error', () => {
    expect(
      parseChatComposerSubmission('/exit', [LOCAL_EXIT_SLASH_COMMAND], {
        hasAttachments: true,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'attachment-error' });
  });

  it('rejects arguments with command-specific feedback data', () => {
    expect(
      parseChatComposerSubmission('/exit now', [LOCAL_EXIT_SLASH_COMMAND], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'argument-error', message: '/exit does not take arguments.' });
  });

  it.each(['/quit', '/q'])('keeps remote alias %s as an ordinary prompt', input => {
    expect(
      parseChatComposerSubmission(input, [LOCAL_NEW_SLASH_COMMAND, LOCAL_EXIT_SLASH_COMMAND], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({ commands: [EXIT, QUIT, Q] }),
      })
    ).toEqual({ type: 'prompt', prompt: input });
  });

  it('returns upgrade-required for reserved /exit with an empty catalog', () => {
    expect(
      parseChatComposerSubmission('/exit', [], {
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

  it.each(['/quit', '/q'])('keeps alias %s as a prompt when upgrade is required', input => {
    expect(
      parseChatComposerSubmission(input, [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          commands: [],
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'prompt', prompt: input });
  });

  it.each(['cloud-agent', 'read-only', null] as const)(
    'does not reserve /exit for %s sessions',
    sessionType => {
      expect(
        parseChatComposerSubmission('/exit', [], {
          hasAttachments: false,
          sessionType,
          remoteCommandState: remoteState(),
        })
      ).toEqual({ type: 'prompt', prompt: '/exit' });
    }
  );
});
