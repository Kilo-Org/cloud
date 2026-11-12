import { describe, expect, it } from 'vitest';

import { androidChannelIdForPushData } from '@kilocode/notifications';

import { expoPushExtrasForPushData } from './push-message-extras';

const ACCOUNT = 'user_2bTgYqJ1aK';
const SESSION = 'ses_01JQ8ZK3W7Q0B5V6N4M2C9X1RT';

function statusPush(sessionId = SESSION) {
  return {
    type: 'cloud_agent_session' as const,
    cliSessionId: sessionId,
    category: 'status' as const,
  };
}

describe('expoPushExtrasForPushData', () => {
  it('returns the permission-with-PR category and the time-sensitive level for a classified raise with a PR', async () => {
    const extras = await expoPushExtrasForPushData(
      {
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
        category: 'attention',
        attentionKind: 'permission',
        prUrl: 'https://github.com/kilo/kilocode/pull/42',
      },
      ACCOUNT
    );

    expect(extras).toEqual({
      categoryId: 'kilo-needs-input:permission-pr',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('drops the PR suffix when the session has no PR', async () => {
    const extras = await expoPushExtrasForPushData(
      {
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
        category: 'attention',
        attentionKind: 'permission',
      },
      ACCOUNT
    );

    expect(extras).toEqual({
      categoryId: 'kilo-needs-input:permission',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('returns the question category for a question raise', async () => {
    const extras = await expoPushExtrasForPushData(
      {
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
        category: 'attention',
        attentionKind: 'question',
        prUrl: 'https://github.com/kilo/kilocode/pull/42',
      },
      ACCOUNT
    );

    expect(extras).toEqual({
      categoryId: 'kilo-needs-input:question-pr',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('defaults to the unknown category for an old producer that omitted attentionKind, without throwing', async () => {
    const extras = await expoPushExtrasForPushData(
      { type: 'cloud_agent_session', cliSessionId: 'ses_1', category: 'attention' },
      ACCOUNT
    );

    expect(extras).toEqual({
      categoryId: 'kilo-needs-input:unknown',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('keeps the PR suffix on the unknown category when the old producer still sent a PR', async () => {
    const extras = await expoPushExtrasForPushData(
      {
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
        category: 'attention',
        prUrl: 'https://github.com/kilo/kilocode/pull/42',
      },
      ACCOUNT
    );

    expect(extras).toEqual({
      categoryId: 'kilo-needs-input:unknown-pr',
      interruptionLevel: 'time-sensitive',
    });
  });

  it('puts an attention raise in no thread, so its actions stay directly reachable', async () => {
    const extras = await expoPushExtrasForPushData(
      { type: 'cloud_agent_session', cliSessionId: SESSION, category: 'attention' },
      ACCOUNT
    );

    expect(extras).not.toHaveProperty('threadId');
  });

  it('returns the session thread for an ordinary status push, whatever else it carries', async () => {
    const extras = await expoPushExtrasForPushData(
      { ...statusPush(), prUrl: 'https://github.com/kilo/kilocode/pull/42' },
      ACCOUNT
    );

    expect(Object.keys(extras)).toEqual(['threadId']);
    expect(extras.threadId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns the session thread when the category is absent (rolling-deploy default)', async () => {
    const extras = await expoPushExtrasForPushData(
      { type: 'cloud_agent_session', cliSessionId: SESSION },
      ACCOUNT
    );

    expect(extras.threadId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps one session in one thread and a second session in another', async () => {
    const first = await expoPushExtrasForPushData(statusPush(SESSION), ACCOUNT);
    const repeated = await expoPushExtrasForPushData(statusPush(SESSION), ACCOUNT);
    const other = await expoPushExtrasForPushData(
      statusPush('ses_01JQ8ZK3W7Q0B5V6N4M2C9X1RU'),
      ACCOUNT
    );

    expect(repeated.threadId).toBe(first.threadId);
    expect(other.threadId).not.toBe(first.threadId);
  });

  it('keeps a second account out of the first account thread for the same session id', async () => {
    const mine = await expoPushExtrasForPushData(statusPush(SESSION), ACCOUNT);
    const theirs = await expoPushExtrasForPushData(statusPush(SESSION), 'user_2bTgYqJ1aL');

    expect(theirs.threadId).not.toBe(mine.threadId);
  });

  it('keeps the account id and the session id out of the key', async () => {
    const extras = await expoPushExtrasForPushData(statusPush(SESSION), ACCOUNT);

    expect(extras.threadId).not.toContain(ACCOUNT);
    expect(extras.threadId).not.toContain(SESSION);
  });

  it('omits the thread when the push carries no session identity', async () => {
    const extras = await expoPushExtrasForPushData(statusPush(''), ACCOUNT);

    expect(extras).toEqual({});
  });

  it('returns no extras for a non-cloud-agent push', async () => {
    const extras = await expoPushExtrasForPushData(
      { type: 'chat.message', sandboxId: 'sb_1', conversationId: 'conv_1', messageId: 'msg_1' },
      ACCOUNT
    );

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
