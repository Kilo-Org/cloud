import { describe, expect, it } from 'vitest';

import { type SlashCommandInfo } from '@kilocode/cloud-agent-sdk';

import {
  getLocalNewSlashCommand,
  parseChatComposerSubmission,
} from '@/components/agents/chat-composer-slash-commands';

const COMPACT: SlashCommandInfo = { name: 'compact', description: 'Compact', hints: [] };
const REVIEW: SlashCommandInfo = { name: 'review', description: 'Review', hints: [] };
const SAMPLE_COMMANDS: SlashCommandInfo[] = [COMPACT, REVIEW];

describe('parseChatComposerSubmission — /new reserved only for remote sessions', () => {
  it('keeps /new as a prompt for cloud-agent sessions when it is not reported', () => {
    expect(
      parseChatComposerSubmission('/new', SAMPLE_COMMANDS, {
        hasAttachments: false,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'prompt', prompt: '/new' });
  });

  it('treats reported /new as a normal command for cloud-agent sessions, preserving arguments', () => {
    expect(
      parseChatComposerSubmission(
        '/new extra args',
        [...SAMPLE_COMMANDS, getLocalNewSlashCommand()],
        {
          hasAttachments: false,
          sessionType: 'cloud-agent',
          remoteCommandState: null,
        }
      )
    ).toEqual({ type: 'command', command: 'new', arguments: 'extra args' });
  });

  it('applies ordinary command attachment semantics to reported /new in cloud-agent sessions', () => {
    expect(
      parseChatComposerSubmission('/new', [...SAMPLE_COMMANDS, getLocalNewSlashCommand()], {
        hasAttachments: true,
        sessionType: 'cloud-agent',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'attachment-error' });
  });

  it('keeps /new as a prompt for read-only sessions', () => {
    expect(
      parseChatComposerSubmission('/new', SAMPLE_COMMANDS, {
        hasAttachments: false,
        sessionType: 'read-only',
        remoteCommandState: null,
      })
    ).toEqual({ type: 'prompt', prompt: '/new' });
  });

  it('keeps /new as a prompt for unresolved sessions', () => {
    expect(
      parseChatComposerSubmission('/new', SAMPLE_COMMANDS, {
        hasAttachments: false,
        sessionType: null,
        remoteCommandState: null,
      })
    ).toEqual({ type: 'prompt', prompt: '/new' });
  });
});
