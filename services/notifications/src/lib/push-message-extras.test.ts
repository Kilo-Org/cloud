import { describe, expect, it } from 'vitest';

import { androidChannelIdForPushData } from '@kilocode/notifications';

import { expoPushExtrasForPushData } from './push-message-extras';

describe('expoPushExtrasForPushData', () => {
  it('returns the permission-with-PR category and the time-sensitive level for a classified raise with a PR', () => {
    const extras = expoPushExtrasForPushData({
      type: 'cloud_agent_session',
      cliSessionId: 'ses_1',
      category: 'attention',
      attentionKind: 'permission',
      prUrl: 'https://github.com/kilo/kilocode/pull/42',
    });

    expect(extras).toEqual({
      categoryId: 'kilo-needs-input:permission-pr',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('drops the PR suffix when the session has no PR', () => {
    const extras = expoPushExtrasForPushData({
      type: 'cloud_agent_session',
      cliSessionId: 'ses_1',
      category: 'attention',
      attentionKind: 'permission',
    });

    expect(extras).toEqual({
      categoryId: 'kilo-needs-input:permission',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('returns the question category for a question raise', () => {
    const extras = expoPushExtrasForPushData({
      type: 'cloud_agent_session',
      cliSessionId: 'ses_1',
      category: 'attention',
      attentionKind: 'question',
      prUrl: 'https://github.com/kilo/kilocode/pull/42',
    });

    expect(extras).toEqual({
      categoryId: 'kilo-needs-input:question-pr',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('defaults to the unknown category for an old producer that omitted attentionKind, without throwing', () => {
    const extras = expoPushExtrasForPushData({
      type: 'cloud_agent_session',
      cliSessionId: 'ses_1',
      category: 'attention',
    });

    expect(extras).toEqual({
      categoryId: 'kilo-needs-input:unknown',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('keeps the PR suffix on the unknown category when the old producer still sent a PR', () => {
    const extras = expoPushExtrasForPushData({
      type: 'cloud_agent_session',
      cliSessionId: 'ses_1',
      category: 'attention',
      prUrl: 'https://github.com/kilo/kilocode/pull/42',
    });

    expect(extras).toEqual({
      categoryId: 'kilo-needs-input:unknown-pr',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('returns no extras for an ordinary status push, even with a raise PR present', () => {
    const extras = expoPushExtrasForPushData({
      type: 'cloud_agent_session',
      cliSessionId: 'ses_1',
      category: 'status',
      prUrl: 'https://github.com/kilo/kilocode/pull/42',
    });

    expect(extras).toEqual({});
    expect(Object.keys(extras)).toEqual([]);
  });

  it('returns no extras when the category is absent (rolling-deploy default)', () => {
    const extras = expoPushExtrasForPushData({
      type: 'cloud_agent_session',
      cliSessionId: 'ses_1',
    });

    expect(extras).toEqual({});
  });

  it('returns no extras for a non-cloud-agent push', () => {
    const extras = expoPushExtrasForPushData({
      type: 'chat.message',
      sandboxId: 'sb_1',
      conversationId: 'conv_1',
      messageId: 'msg_1',
    });

    expect(extras).toEqual({});
  });
});

describe('androidChannelIdForPushData (attention routing)', () => {
  it('routes an attention raise to needs-input and ordinary progress to the quiet channel', () => {
    expect(
      androidChannelIdForPushData({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
        category: 'attention',
      })
    ).toBe('needs-input');
    expect(
      androidChannelIdForPushData({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
        category: 'status',
      })
    ).toBe('agent-progress');
  });

  it('routes a category-less old producer push to the quiet progress channel', () => {
    expect(
      androidChannelIdForPushData({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
      })
    ).toBe('agent-progress');
  });
});
