import { describe, expect, it } from 'vitest';

import { type SlashCommandInfo } from '@kilocode/cloud-agent-sdk';
import { type RemoteCommandState } from '@kilocode/cloud-agent-sdk/remote-command-catalog';

import {
  createMobileSlashCommandList,
  getLocalClearSlashCommand,
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

describe('parseChatComposerSubmission — /clear (capability-gated restart)', () => {
  it('routes /clear to restart-session when canExitSession is true', () => {
    expect(
      parseChatComposerSubmission('/clear', [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({ canExitSession: true }),
      })
    ).toEqual({ type: 'restart-session' });
  });

  it('returns upgrade-required when canExitSession is absent (old CLI)', () => {
    expect(
      parseChatComposerSubmission('/clear', [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({ canExitSession: undefined }),
      })
    ).toEqual({
      type: 'upgrade-required',
      message: 'Update your CLI to restart the session.',
    });
  });

  it('returns upgrade-required when canExitSession is false', () => {
    expect(
      parseChatComposerSubmission('/clear', [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({ canExitSession: false }),
      })
    ).toEqual({
      type: 'upgrade-required',
      message: 'Update your CLI to restart the session.',
    });
  });

  it('returns upgrade-required with the CLI message when refresh is upgrade-required', () => {
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
    ).toEqual({ type: 'upgrade-required', message: 'Please upgrade your CLI' });
  });

  it('rejects /clear with arguments', () => {
    expect(
      parseChatComposerSubmission('/clear extra', [], {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({ canExitSession: true }),
      })
    ).toEqual({ type: 'argument-error', message: '/clear does not take arguments.' });
  });

  it('rejects /clear with attachments', () => {
    expect(
      parseChatComposerSubmission('/clear', [], {
        hasAttachments: true,
        sessionType: 'remote',
        remoteCommandState: remoteState({ canExitSession: true }),
      })
    ).toEqual({ type: 'attachment-error' });
  });

  it('still falls through to prompt for non-remote sessions', () => {
    expect(
      parseChatComposerSubmission('/clear', SAMPLE_COMMANDS, {
        hasAttachments: false,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'prompt', prompt: '/clear' });
  });
});

describe('createMobileSlashCommandList — /clear capability gate', () => {
  it('includes clear only when canExitSession is true', () => {
    const list = createMobileSlashCommandList(
      'remote',
      [],
      remoteState({ commands: [], canExitSession: true })
    );
    const names = list.map(command => command.name);
    expect(names).toContain('clear');
    expect(names).toContain('exit');
    expect(names).toContain('new');
  });

  it('omits clear when canExitSession is absent', () => {
    const list = createMobileSlashCommandList(
      'remote',
      [],
      remoteState({ commands: [], canExitSession: undefined })
    );
    expect(list.map(command => command.name)).not.toContain('clear');
  });

  it('has the updated description', () => {
    expect(getLocalClearSlashCommand().description).toBe('End this session and start a new one');
  });
});
