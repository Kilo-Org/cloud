import { db } from '@/lib/drizzle';
import {
  claimBotRequestCloudAgentSessionGroupContinuation,
  getBotRequestCloudAgentSessionGroup,
  getBotRequestCloudAgentSessionGroupReadiness,
} from '@/lib/bot/cloud-agent-session-groups';
import {
  markBotRequestCloudAgentSessionTerminal,
  recordBotRequestCloudAgentSession,
  recordBotRequestCloudAgentSessionResult,
  recordBotRequestCloudAgentSessionResultError,
} from '@/lib/bot/request-logging';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  bot_request_cloud_agent_sessions,
  bot_requests,
  kilocode_users,
} from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';

describe('bot request Cloud Agent session groups', () => {
  const createdBotRequestIds = new Set<string>();
  const createdCloudAgentSessionIds = new Set<string>();
  const createdUserIds = new Set<string>();

  async function createBotRequest() {
    const user = await insertTestUser();
    createdUserIds.add(user.id);

    const [row] = await db
      .insert(bot_requests)
      .values({
        created_by: user.id,
        platform: 'slack',
        platform_thread_id: `slack:T123:C456:${randomUUID()}`,
        platform_message_id: `message-${randomUUID()}`,
        user_message: 'Please make a change',
        status: 'pending',
      })
      .returning({ id: bot_requests.id });

    if (!row) {
      throw new Error('Failed to create bot request fixture');
    }

    createdBotRequestIds.add(row.id);
    return row.id;
  }

  afterEach(async () => {
    const cloudAgentSessionIds = Array.from(createdCloudAgentSessionIds);
    if (cloudAgentSessionIds.length > 0) {
      await db
        .delete(bot_request_cloud_agent_sessions)
        .where(
          inArray(bot_request_cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionIds)
        );
    }

    const botRequestIds = Array.from(createdBotRequestIds);
    if (botRequestIds.length > 0) {
      await db.delete(bot_requests).where(inArray(bot_requests.id, botRequestIds));
    }

    const userIds = Array.from(createdUserIds);
    if (userIds.length > 0) {
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
    }

    createdCloudAgentSessionIds.clear();
    createdBotRequestIds.clear();
    createdUserIds.clear();
  });

  it('waits to claim a child session group until all siblings are terminal with stored results', async () => {
    const botRequestId = await createBotRequest();
    const spawnGroupId = randomUUID();
    const firstCloudAgentSessionId = `cas-child-group-first-${randomUUID()}`;
    const secondCloudAgentSessionId = `cas-child-group-second-${randomUUID()}`;
    createdCloudAgentSessionIds.add(firstCloudAgentSessionId);
    createdCloudAgentSessionIds.add(secondCloudAgentSessionId);

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId,
      cloudAgentSessionId: firstCloudAgentSessionId,
      callbackStep: 2,
    });
    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId,
      cloudAgentSessionId: secondCloudAgentSessionId,
      callbackStep: 2,
    });

    await markBotRequestCloudAgentSessionTerminal({
      botRequestId,
      cloudAgentSessionId: firstCloudAgentSessionId,
      status: 'completed',
      kiloSessionId: `kilo-first-${randomUUID()}`,
    });

    const partiallyCompleteGroup = await getBotRequestCloudAgentSessionGroup({
      botRequestId,
      cloudAgentSessionId: firstCloudAgentSessionId,
    });
    expect(partiallyCompleteGroup.sessions.map(session => session.status).sort()).toEqual([
      'completed',
      'running',
    ]);
    await expect(
      claimBotRequestCloudAgentSessionGroupContinuation({
        botRequestId,
        cloudAgentSessionId: firstCloudAgentSessionId,
      })
    ).resolves.toBe(false);

    await markBotRequestCloudAgentSessionTerminal({
      botRequestId,
      cloudAgentSessionId: secondCloudAgentSessionId,
      status: 'completed',
      kiloSessionId: `kilo-second-${randomUUID()}`,
    });

    await expect(
      getBotRequestCloudAgentSessionGroupReadiness({
        botRequestId,
        cloudAgentSessionId: secondCloudAgentSessionId,
      })
    ).resolves.toMatchObject({ status: 'waiting-for-result' });
    await expect(
      claimBotRequestCloudAgentSessionGroupContinuation({
        botRequestId,
        cloudAgentSessionId: secondCloudAgentSessionId,
      })
    ).resolves.toBe(false);

    await recordBotRequestCloudAgentSessionResult({
      botRequestId,
      cloudAgentSessionId: firstCloudAgentSessionId,
      finalMessage: 'first final message',
    });
    await recordBotRequestCloudAgentSessionResult({
      botRequestId,
      cloudAgentSessionId: secondCloudAgentSessionId,
      finalMessage: 'second final message',
    });

    await expect(
      getBotRequestCloudAgentSessionGroupReadiness({
        botRequestId,
        cloudAgentSessionId: secondCloudAgentSessionId,
      })
    ).resolves.toMatchObject({ status: 'ready' });
    await expect(
      claimBotRequestCloudAgentSessionGroupContinuation({
        botRequestId,
        cloudAgentSessionId: secondCloudAgentSessionId,
      })
    ).resolves.toBe(true);
    await expect(
      claimBotRequestCloudAgentSessionGroupContinuation({
        botRequestId,
        cloudAgentSessionId: firstCloudAgentSessionId,
      })
    ).resolves.toBe(false);

    const claimedGroup = await getBotRequestCloudAgentSessionGroup({
      botRequestId,
      cloudAgentSessionId: firstCloudAgentSessionId,
    });
    expect(claimedGroup.sessions).toHaveLength(2);
    expect(claimedGroup.sessions.every(session => session.continuation_started_at)).toBe(true);
  });

  it('reports result errors and still claims the terminal group once', async () => {
    const botRequestId = await createBotRequest();
    const spawnGroupId = randomUUID();
    const cloudAgentSessionId = `cas-child-group-result-error-${randomUUID()}`;
    createdCloudAgentSessionIds.add(cloudAgentSessionId);

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId,
      cloudAgentSessionId,
    });
    await markBotRequestCloudAgentSessionTerminal({
      botRequestId,
      cloudAgentSessionId,
      status: 'completed',
      kiloSessionId: `kilo-result-error-${randomUUID()}`,
    });
    await recordBotRequestCloudAgentSessionResultError({
      botRequestId,
      cloudAgentSessionId,
      errorMessage: 'ingest returned no final assistant text',
    });

    await expect(
      getBotRequestCloudAgentSessionGroupReadiness({
        botRequestId,
        cloudAgentSessionId,
      })
    ).resolves.toMatchObject({ status: 'result-error' });
    await expect(
      claimBotRequestCloudAgentSessionGroupContinuation({
        botRequestId,
        cloudAgentSessionId,
      })
    ).resolves.toBe(true);
  });

  it('waits for sibling results before claiming a group with result errors', async () => {
    const botRequestId = await createBotRequest();
    const spawnGroupId = randomUUID();
    const firstCloudAgentSessionId = `cas-child-group-result-error-first-${randomUUID()}`;
    const secondCloudAgentSessionId = `cas-child-group-result-error-second-${randomUUID()}`;
    createdCloudAgentSessionIds.add(firstCloudAgentSessionId);
    createdCloudAgentSessionIds.add(secondCloudAgentSessionId);

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId,
      cloudAgentSessionId: firstCloudAgentSessionId,
    });
    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId,
      cloudAgentSessionId: secondCloudAgentSessionId,
    });
    await markBotRequestCloudAgentSessionTerminal({
      botRequestId,
      cloudAgentSessionId: firstCloudAgentSessionId,
      status: 'completed',
      kiloSessionId: `kilo-result-error-first-${randomUUID()}`,
    });
    await markBotRequestCloudAgentSessionTerminal({
      botRequestId,
      cloudAgentSessionId: secondCloudAgentSessionId,
      status: 'completed',
      kiloSessionId: `kilo-result-error-second-${randomUUID()}`,
    });
    await recordBotRequestCloudAgentSessionResultError({
      botRequestId,
      cloudAgentSessionId: firstCloudAgentSessionId,
      errorMessage: 'ingest returned no final assistant text',
    });

    await expect(
      getBotRequestCloudAgentSessionGroupReadiness({
        botRequestId,
        cloudAgentSessionId: firstCloudAgentSessionId,
      })
    ).resolves.toMatchObject({ status: 'waiting-for-result' });
    await expect(
      claimBotRequestCloudAgentSessionGroupContinuation({
        botRequestId,
        cloudAgentSessionId: firstCloudAgentSessionId,
      })
    ).resolves.toBe(false);

    await recordBotRequestCloudAgentSessionResult({
      botRequestId,
      cloudAgentSessionId: secondCloudAgentSessionId,
      finalMessage: 'second final message',
    });

    await expect(
      getBotRequestCloudAgentSessionGroupReadiness({
        botRequestId,
        cloudAgentSessionId: firstCloudAgentSessionId,
      })
    ).resolves.toMatchObject({ status: 'result-error' });
    await expect(
      claimBotRequestCloudAgentSessionGroupContinuation({
        botRequestId,
        cloudAgentSessionId: firstCloudAgentSessionId,
      })
    ).resolves.toBe(true);
  });

  it('orders child session groups by callback step, creation time, and session id', async () => {
    const botRequestId = await createBotRequest();
    const spawnGroupId = randomUUID();
    const firstCloudAgentSessionId = `cas-child-order-first-${randomUUID()}`;
    const secondCloudAgentSessionId = `cas-child-order-second-${randomUUID()}`;
    createdCloudAgentSessionIds.add(firstCloudAgentSessionId);
    createdCloudAgentSessionIds.add(secondCloudAgentSessionId);

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId,
      cloudAgentSessionId: firstCloudAgentSessionId,
      callbackStep: 3,
    });
    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId,
      cloudAgentSessionId: secondCloudAgentSessionId,
      callbackStep: 2,
    });

    const group = await getBotRequestCloudAgentSessionGroup({
      botRequestId,
      cloudAgentSessionId: firstCloudAgentSessionId,
    });

    expect(group.sessions.map(session => session.cloud_agent_session_id)).toEqual([
      secondCloudAgentSessionId,
      firstCloudAgentSessionId,
    ]);
  });
});
