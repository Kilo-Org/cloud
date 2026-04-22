import { db } from '@/lib/drizzle';
import {
  linkBotRequestToSession,
  markBotRequestCloudAgentSessionTerminal,
  recordBotRequestCloudAgentSession,
} from '@/lib/bot/request-logging';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  bot_request_cloud_agent_sessions,
  bot_requests,
  kilocode_users,
} from '@kilocode/db/schema';
import { count, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';

function expectSingleRow<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) {
    throw new Error('Expected one row');
  }
  return row;
}

describe('bot request logging', () => {
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

  it('records a child Cloud Agent session for an existing bot request', async () => {
    const botRequestId = await createBotRequest();
    const spawnGroupId = randomUUID();
    const cloudAgentSessionId = `cas-child-insert-${randomUUID()}`;
    const kiloSessionId = `kilo-child-insert-${randomUUID()}`;
    createdCloudAgentSessionIds.add(cloudAgentSessionId);

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId,
      cloudAgentSessionId,
      kiloSessionId,
      mode: 'code',
      githubRepo: 'kilocode/cloud',
      gitlabProject: 'group/project',
      callbackStep: 3,
    });

    const row = expectSingleRow(
      await db
        .select()
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId))
    );

    expect(row.bot_request_id).toBe(botRequestId);
    expect(row.spawn_group_id).toBe(spawnGroupId);
    expect(row.cloud_agent_session_id).toBe(cloudAgentSessionId);
    expect(row.kilo_session_id).toBe(kiloSessionId);
    expect(row.mode).toBe('code');
    expect(row.github_repo).toBe('kilocode/cloud');
    expect(row.gitlab_project).toBe('group/project');
    expect(row.callback_step).toBe(3);
    expect(row.status).toBe('running');
  });

  it('upserts duplicate child sessions without changing terminal fields', async () => {
    const botRequestId = await createBotRequest();
    const initialSpawnGroupId = randomUUID();
    const updatedSpawnGroupId = randomUUID();
    const cloudAgentSessionId = `cas-child-upsert-${randomUUID()}`;
    const kiloSessionId = `kilo-child-upsert-${randomUUID()}`;
    const terminalAt = new Date('2026-01-02T03:04:05.000Z').toISOString();
    const continuationStartedAt = new Date('2026-01-02T03:05:06.000Z').toISOString();
    createdCloudAgentSessionIds.add(cloudAgentSessionId);

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId: initialSpawnGroupId,
      cloudAgentSessionId,
    });

    await db
      .update(bot_request_cloud_agent_sessions)
      .set({
        status: 'completed',
        error_message: 'kept terminal error',
        terminal_at: terminalAt,
        continuation_started_at: continuationStartedAt,
      })
      .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId));

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId: updatedSpawnGroupId,
      cloudAgentSessionId,
      kiloSessionId,
      mode: 'ask',
      gitlabProject: 'group/subgroup/project',
      callbackStep: 7,
    });

    const countRow = expectSingleRow(
      await db
        .select({ childSessionCount: count() })
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId))
    );

    expect(countRow.childSessionCount).toBe(1);

    const row = expectSingleRow(
      await db
        .select()
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId))
    );

    expect(row.spawn_group_id).toBe(updatedSpawnGroupId);
    expect(row.kilo_session_id).toBe(kiloSessionId);
    expect(row.mode).toBe('ask');
    expect(row.gitlab_project).toBe('group/subgroup/project');
    expect(row.callback_step).toBe(7);
    expect(row.status).toBe('completed');
    expect(row.error_message).toBe('kept terminal error');
    expect(new Date(row.terminal_at ?? '').toISOString()).toBe(terminalAt);
    expect(new Date(row.continuation_started_at ?? '').toISOString()).toBe(continuationStartedAt);
  });

  it('marks a child Cloud Agent session terminal from callback metadata', async () => {
    const botRequestId = await createBotRequest();
    const spawnGroupId = randomUUID();
    const cloudAgentSessionId = `cas-child-terminal-${randomUUID()}`;
    const kiloSessionId = `kilo-child-terminal-${randomUUID()}`;
    const terminalAt = new Date('2026-01-03T04:05:06.000Z').toISOString();
    createdCloudAgentSessionIds.add(cloudAgentSessionId);

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId,
      cloudAgentSessionId,
    });

    await markBotRequestCloudAgentSessionTerminal({
      botRequestId,
      cloudAgentSessionId,
      status: 'failed',
      executionId: 'execution-terminal-test',
      kiloSessionId,
      errorMessage: 'session failed',
      terminalAt,
    });

    const row = expectSingleRow(
      await db
        .select()
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId))
    );

    expect(row.status).toBe('failed');
    expect(row.execution_id).toBe('execution-terminal-test');
    expect(row.kilo_session_id).toBe(kiloSessionId);
    expect(row.error_message).toBe('session failed');
    expect(new Date(row.terminal_at ?? '').toISOString()).toBe(terminalAt);
  });

  it('continues linking the legacy Cloud Agent session column', async () => {
    const botRequestId = await createBotRequest();
    const cloudAgentSessionId = `cas-legacy-link-${randomUUID()}`;

    await linkBotRequestToSession(botRequestId, cloudAgentSessionId);

    const row = expectSingleRow(
      await db.select().from(bot_requests).where(eq(bot_requests.id, botRequestId))
    );

    expect(row.cloud_agent_session_id).toBe(cloudAgentSessionId);
  });
});
