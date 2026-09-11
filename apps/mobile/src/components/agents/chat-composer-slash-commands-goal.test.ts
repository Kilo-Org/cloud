import { describe, expect, it } from 'vitest';

import { type SlashCommandInfo } from '@kilocode/cloud-agent-sdk';
import { type RemoteCommandState } from '@kilocode/cloud-agent-sdk/remote-command-catalog';

import { parseChatComposerSubmission } from '@/components/agents/chat-composer-slash-commands';

const COMPACT: SlashCommandInfo = { name: 'compact', description: 'Compact', hints: [] };
const GOAL: SlashCommandInfo = { name: 'goal', description: 'Goal', hints: [] };
const WITHOUT_GOAL: SlashCommandInfo[] = [COMPACT];
const WITH_GOAL: SlashCommandInfo[] = [COMPACT, GOAL];

function remoteState(overrides: Partial<RemoteCommandState> = {}): RemoteCommandState {
  return {
    ownerConnectionId: 'conn-1',
    refresh: 'idle',
    commands: WITH_GOAL,
    ...overrides,
  };
}

describe('parseChatComposerSubmission — /goal compose mode', () => {
  it('routes a bare /goal to goal-compose', () => {
    expect(
      parseChatComposerSubmission('/goal', WITH_GOAL, {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'goal-compose' });
  });

  it('routes /goal with only trailing whitespace to goal-compose', () => {
    expect(
      parseChatComposerSubmission('/goal   ', WITH_GOAL, {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'goal-compose' });
  });

  it('forwards /goal <objective> as the goal command', () => {
    expect(
      parseChatComposerSubmission('/goal Ship it', WITH_GOAL, {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'command', command: 'goal', arguments: 'Ship it' });
  });

  it.each(['pause', 'resume', 'clear'])('forwards /goal %s as the goal command', argument => {
    expect(
      parseChatComposerSubmission(`/goal ${argument}`, WITH_GOAL, {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'command', command: 'goal', arguments: argument });
  });

  it('forwards /goal for a cloud-agent session whose catalog advertises it', () => {
    expect(
      parseChatComposerSubmission('/goal Ship it', WITH_GOAL, {
        hasAttachments: false,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'command', command: 'goal', arguments: 'Ship it' });
  });

  it('rejects a goal command with attachments', () => {
    expect(
      parseChatComposerSubmission('/goal Ship it', WITH_GOAL, {
        hasAttachments: true,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'attachment-error' });
  });

  it('rejects a bare /goal with attachments before entering compose mode', () => {
    expect(
      parseChatComposerSubmission('/goal', WITH_GOAL, {
        hasAttachments: true,
        sessionType: 'remote',
        remoteCommandState: remoteState(),
      })
    ).toEqual({ type: 'attachment-error' });
  });
});

describe('parseChatComposerSubmission — /goal fail-closed', () => {
  it('returns upgrade-required (never a prompt) for a remote catalog without goal', () => {
    const result = parseChatComposerSubmission('/goal Ship it', WITHOUT_GOAL, {
      hasAttachments: false,
      sessionType: 'remote',
      remoteCommandState: remoteState({ commands: WITHOUT_GOAL }),
    });
    expect(result).toEqual({
      type: 'upgrade-required',
      message: 'Please upgrade your CLI to use this command.',
    });
  });

  it('returns upgrade-required (never a prompt) for a cloud-agent catalog without goal', () => {
    expect(
      parseChatComposerSubmission('/goal Ship it', WITHOUT_GOAL, {
        hasAttachments: false,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({
      type: 'upgrade-required',
      message: 'Please upgrade your CLI to use this command.',
    });
  });

  it('returns upgrade-required for a bare /goal when the remote catalog lacks goal', () => {
    expect(
      parseChatComposerSubmission('/goal', WITHOUT_GOAL, {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({ commands: WITHOUT_GOAL }),
      })
    ).toEqual({
      type: 'upgrade-required',
      message: 'Please upgrade your CLI to use this command.',
    });
  });

  it('returns upgrade-required for a remote session requiring an upgrade', () => {
    expect(
      parseChatComposerSubmission('/goal Ship it', WITH_GOAL, {
        hasAttachments: false,
        sessionType: 'remote',
        remoteCommandState: remoteState({
          refresh: 'upgrade-required',
          message: 'Please upgrade your CLI',
        }),
      })
    ).toEqual({ type: 'upgrade-required', message: 'Please upgrade your CLI' });
  });
});

describe('parseChatComposerSubmission — non-interactive sessions keep /goal as a prompt', () => {
  it('keeps /goal as a prompt for a read-only session', () => {
    expect(
      parseChatComposerSubmission('/goal Ship it', WITHOUT_GOAL, {
        hasAttachments: false,
        sessionType: 'read-only',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'prompt', prompt: '/goal Ship it' });
  });

  it('keeps /goal as a prompt for an unresolved session', () => {
    expect(
      parseChatComposerSubmission('/goal Ship it', WITHOUT_GOAL, {
        hasAttachments: false,
        sessionType: null,
        remoteCommandState: null,
      })
    ).toEqual({ type: 'prompt', prompt: '/goal Ship it' });
  });
});
