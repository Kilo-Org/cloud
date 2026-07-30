import { describe, expect, it } from 'vitest';

import { type SlashCommandInfo } from '@kilocode/cloud-agent-sdk';
import { type RemoteCommandState } from '@kilocode/cloud-agent-sdk/remote-command-catalog';

import {
  LOCAL_CLEAR_SLASH_COMMAND,
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

describe('parseChatComposerSubmission — /clear (client-side, remote only)', () => {
  it('parses exact /clear to a clear command for remote sessions', () => {
    expect(
      parseChatComposerSubmission('/clear', [...SAMPLE_COMMANDS, LOCAL_CLEAR_SLASH_COMMAND], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'command', command: 'clear', arguments: '' });
  });

  it('still parses /clear under upgrade-required (client-side, no CLI capability)', () => {
    expect(
      parseChatComposerSubmission('/clear', [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          commands: [],
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'command', command: 'clear', arguments: '' });
  });

  it('rejects attachments for /clear', () => {
    expect(
      parseChatComposerSubmission('/clear', [...SAMPLE_COMMANDS, LOCAL_CLEAR_SLASH_COMMAND], {
        hasAttachments: true,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'attachment-error' });
  });

  it('rejects /clear with any argument text', () => {
    expect(
      parseChatComposerSubmission('/clear extra', [...SAMPLE_COMMANDS, LOCAL_CLEAR_SLASH_COMMAND], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'argument-error', message: '/clear does not take arguments.' });
  });

  it('keeps /clear as a prompt for cloud-agent sessions when not in the catalog', () => {
    expect(
      parseChatComposerSubmission('/clear', SAMPLE_COMMANDS, {
        hasAttachments: false,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'prompt', prompt: '/clear' });
  });
});
