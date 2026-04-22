/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import {
  linkBotRequestToSession,
  recordBotRequestCloudAgentSession,
} from '@/lib/bot/request-logging';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  bot_request_cloud_agent_sessions,
  bot_requests,
  kilocode_users,
} from '@kilocode/db/schema';
import { count, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

async function createBotRequest() {
  const user = await insertTestUser();
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

  return row.id;
}

function expectSingleRow<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) {
    throw new Error('Expected one row');
  }
  return row;
}

describe('bot request logging', () => {
  afterEach(async () => {
    await db.delete(bot_request_cloud_agent_sessions);
    await db.delete(bot_requests);
    await db.delete(kilocode_users);
  });

  it('records a child Cloud Agent session for an existing bot request', async () => {
    const botRequestId = await createBotRequest();
    const spawnGroupId = randomUUID();

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId,
      cloudAgentSessionId: 'cas-child-insert',
      kiloSessionId: 'kilo-child-insert',
      mode: 'code',
      githubRepo: 'kilocode/cloud',
      gitlabProject: 'group/project',
      callbackStep: 3,
    });

    const row = expectSingleRow(
      await db
        .select()
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, 'cas-child-insert'))
    );

    expect(row.bot_request_id).toBe(botRequestId);
    expect(row.spawn_group_id).toBe(spawnGroupId);
    expect(row.cloud_agent_session_id).toBe('cas-child-insert');
    expect(row.kilo_session_id).toBe('kilo-child-insert');
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
    const terminalAt = new Date('2026-01-02T03:04:05.000Z').toISOString();
    const continuationStartedAt = new Date('2026-01-02T03:05:06.000Z').toISOString();

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId: initialSpawnGroupId,
      cloudAgentSessionId: 'cas-child-upsert',
    });

    await db
      .update(bot_request_cloud_agent_sessions)
      .set({
        status: 'completed',
        error_message: 'kept terminal error',
        terminal_at: terminalAt,
        continuation_started_at: continuationStartedAt,
      })
      .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, 'cas-child-upsert'));

    await recordBotRequestCloudAgentSession({
      botRequestId,
      spawnGroupId: updatedSpawnGroupId,
      cloudAgentSessionId: 'cas-child-upsert',
      kiloSessionId: 'kilo-child-upsert',
      mode: 'ask',
      gitlabProject: 'group/subgroup/project',
      callbackStep: 7,
    });

    const countRow = expectSingleRow(
      await db
        .select({ childSessionCount: count() })
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, 'cas-child-upsert'))
    );

    expect(countRow.childSessionCount).toBe(1);

    const row = expectSingleRow(
      await db
        .select()
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, 'cas-child-upsert'))
    );

    expect(row.spawn_group_id).toBe(updatedSpawnGroupId);
    expect(row.kilo_session_id).toBe('kilo-child-upsert');
    expect(row.mode).toBe('ask');
    expect(row.gitlab_project).toBe('group/subgroup/project');
    expect(row.callback_step).toBe(7);
    expect(row.status).toBe('completed');
    expect(row.error_message).toBe('kept terminal error');
    expect(new Date(row.terminal_at ?? '').toISOString()).toBe(terminalAt);
    expect(new Date(row.continuation_started_at ?? '').toISOString()).toBe(continuationStartedAt);
  });

  it('continues linking the legacy Cloud Agent session column', async () => {
    const botRequestId = await createBotRequest();

    await linkBotRequestToSession(botRequestId, 'cas-legacy-link');

    const row = expectSingleRow(
      await db.select().from(bot_requests).where(eq(bot_requests.id, botRequestId))
    );

    expect(row.cloud_agent_session_id).toBe('cas-legacy-link');
  });
});
