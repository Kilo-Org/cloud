import { describe, expect, it, beforeEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { bot_requests, bot_request_cloud_agent_sessions } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  recordBotRequestCloudAgentSession,
  getBotRequestCloudAgentSession,
  markBotRequestCloudAgentSessionTerminal,
  getBotRequestCloudAgentSessionsForGroup,
  claimCompletedBotRequestSessionGroup,
} from './request-logging';
import { randomUUID } from 'crypto';

describe('bot request logging', () => {
  beforeEach(async () => {
    await db.delete(bot_request_cloud_agent_sessions).where(sql`true`);
    await db.delete(bot_requests).where(sql`true`);
  });

  describe('recordBotRequestCloudAgentSession', () => {
    it('records multiple child sessions for one botRequestId', async () => {
      const user = await insertTestUser();
      const [request] = await db
        .insert(bot_requests)
        .values({
          created_by: user.id,
          platform: 'slack',
          platform_thread_id: 'slack:T123:C456:thread1',
          user_message: 'Hello',
          status: 'pending',
        })
        .returning({ id: bot_requests.id });

      const spawnGroupId = randomUUID();

      await recordBotRequestCloudAgentSession({
        botRequestId: request.id,
        spawnGroupId,
        cloudAgentSessionId: 'agent_1',
        mode: 'code',
        githubRepo: 'owner/repo1',
        callbackStep: 1,
      });

      await recordBotRequestCloudAgentSession({
        botRequestId: request.id,
        spawnGroupId,
        cloudAgentSessionId: 'agent_2',
        mode: 'ask',
        gitlabProject: 'group/project1',
        callbackStep: 2,
      });

      const sessions = await db
        .select()
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.bot_request_id, request.id));

      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.cloud_agent_session_id)).toContain('agent_1');
      expect(sessions.map(s => s.cloud_agent_session_id)).toContain('agent_2');
    });

    it('is idempotent for the same cloudAgentSessionId', async () => {
      const user = await insertTestUser();
      const [request] = await db
        .insert(bot_requests)
        .values({
          created_by: user.id,
          platform: 'slack',
          platform_thread_id: 'slack:T123:C456:thread1',
          user_message: 'Hello',
          status: 'pending',
        })
        .returning({ id: bot_requests.id });

      const spawnGroupId = randomUUID();

      await recordBotRequestCloudAgentSession({
        botRequestId: request.id,
        spawnGroupId,
        cloudAgentSessionId: 'agent_dup',
        mode: 'code',
      });

      await recordBotRequestCloudAgentSession({
        botRequestId: request.id,
        spawnGroupId,
        cloudAgentSessionId: 'agent_dup',
        mode: 'ask',
      });

      const sessions = await db
        .select()
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.bot_request_id, request.id));

      expect(sessions).toHaveLength(1);
      expect(sessions[0].mode).toBe('code');
    });

    it('does not write to bot_requests when recording a child session', async () => {
      const user = await insertTestUser();
      const [request] = await db
        .insert(bot_requests)
        .values({
          created_by: user.id,
          platform: 'slack',
          platform_thread_id: 'slack:T123:C456:thread1',
          user_message: 'Hello',
          status: 'pending',
        })
        .returning({ id: bot_requests.id, updated_at: bot_requests.updated_at });

      const beforeUpdatedAt = request.updated_at;

      await recordBotRequestCloudAgentSession({
        botRequestId: request.id,
        spawnGroupId: randomUUID(),
        cloudAgentSessionId: 'agent_1',
      });

      const [afterRequest] = await db
        .select({ updated_at: bot_requests.updated_at })
        .from(bot_requests)
        .where(eq(bot_requests.id, request.id));

      expect(afterRequest.updated_at).toBe(beforeUpdatedAt);
    });
  });

  describe('getBotRequestCloudAgentSession', () => {
    it('returns the matching session', async () => {
      const user = await insertTestUser();
      const [request] = await db
        .insert(bot_requests)
        .values({
          created_by: user.id,
          platform: 'slack',
          platform_thread_id: 'slack:T123:C456:thread1',
          user_message: 'Hello',
          status: 'pending',
        })
        .returning({ id: bot_requests.id });

      await db.insert(bot_request_cloud_agent_sessions).values({
        bot_request_id: request.id,
        spawn_group_id: randomUUID(),
        cloud_agent_session_id: 'agent_x',
        status: 'running',
      });

      const found = await getBotRequestCloudAgentSession(request.id, 'agent_x');
      expect(found).not.toBeNull();
      expect(found?.cloud_agent_session_id).toBe('agent_x');
    });

    it('returns null when no session matches', async () => {
      const found = await getBotRequestCloudAgentSession(randomUUID(), 'agent_missing');
      expect(found).toBeNull();
    });
  });

  describe('markBotRequestCloudAgentSessionTerminal', () => {
    it('marks a session completed with kiloSessionId and executionId', async () => {
      const user = await insertTestUser();
      const [request] = await db
        .insert(bot_requests)
        .values({
          created_by: user.id,
          platform: 'slack',
          platform_thread_id: 'slack:T123:C456:thread1',
          user_message: 'Hello',
          status: 'pending',
        })
        .returning({ id: bot_requests.id });

      await db.insert(bot_request_cloud_agent_sessions).values({
        bot_request_id: request.id,
        spawn_group_id: randomUUID(),
        cloud_agent_session_id: 'agent_y',
        status: 'running',
      });

      await markBotRequestCloudAgentSessionTerminal({
        botRequestId: request.id,
        cloudAgentSessionId: 'agent_y',
        status: 'completed',
        kiloSessionId: 'kilo_123',
        executionId: 'exec_456',
      });

      const [row] = await db
        .select()
        .from(bot_request_cloud_agent_sessions)
        .where(eq(bot_request_cloud_agent_sessions.cloud_agent_session_id, 'agent_y'));

      expect(row.status).toBe('completed');
      expect(row.kilo_session_id).toBe('kilo_123');
      expect(row.execution_id).toBe('exec_456');
      expect(row.terminal_at).not.toBeNull();
    });
  });

  describe('getBotRequestCloudAgentSessionsForGroup', () => {
    it('returns sessions ordered by created_at', async () => {
      const user = await insertTestUser();
      const [request] = await db
        .insert(bot_requests)
        .values({
          created_by: user.id,
          platform: 'slack',
          platform_thread_id: 'slack:T123:C456:thread1',
          user_message: 'Hello',
          status: 'pending',
        })
        .returning({ id: bot_requests.id });

      const spawnGroupId = randomUUID();
      const otherGroupId = randomUUID();

      await db.insert(bot_request_cloud_agent_sessions).values([
        {
          bot_request_id: request.id,
          spawn_group_id: spawnGroupId,
          cloud_agent_session_id: 'agent_a',
          status: 'running',
        },
        {
          bot_request_id: request.id,
          spawn_group_id: spawnGroupId,
          cloud_agent_session_id: 'agent_b',
          status: 'running',
        },
        {
          bot_request_id: request.id,
          spawn_group_id: otherGroupId,
          cloud_agent_session_id: 'agent_c',
          status: 'running',
        },
      ]);

      const groupSessions = await getBotRequestCloudAgentSessionsForGroup(request.id, spawnGroupId);
      expect(groupSessions).toHaveLength(2);
      expect(groupSessions.map(s => s.cloud_agent_session_id)).toEqual(['agent_a', 'agent_b']);
    });
  });

  describe('claimCompletedBotRequestSessionGroup', () => {
    it('returns rows once and returns none on a second claim', async () => {
      const user = await insertTestUser();
      const [request] = await db
        .insert(bot_requests)
        .values({
          created_by: user.id,
          platform: 'slack',
          platform_thread_id: 'slack:T123:C456:thread1',
          user_message: 'Hello',
          status: 'pending',
        })
        .returning({ id: bot_requests.id });

      const spawnGroupId = randomUUID();

      await db.insert(bot_request_cloud_agent_sessions).values([
        {
          bot_request_id: request.id,
          spawn_group_id: spawnGroupId,
          cloud_agent_session_id: 'agent_1',
          status: 'completed',
          terminal_at: new Date().toISOString(),
        },
        {
          bot_request_id: request.id,
          spawn_group_id: spawnGroupId,
          cloud_agent_session_id: 'agent_2',
          status: 'failed',
          terminal_at: new Date().toISOString(),
        },
      ]);

      const firstClaim = await claimCompletedBotRequestSessionGroup(request.id, spawnGroupId);
      expect(firstClaim).toHaveLength(2);

      const secondClaim = await claimCompletedBotRequestSessionGroup(request.id, spawnGroupId);
      expect(secondClaim).toHaveLength(0);
    });

    it('returns empty when a session is still running', async () => {
      const user = await insertTestUser();
      const [request] = await db
        .insert(bot_requests)
        .values({
          created_by: user.id,
          platform: 'slack',
          platform_thread_id: 'slack:T123:C456:thread1',
          user_message: 'Hello',
          status: 'pending',
        })
        .returning({ id: bot_requests.id });

      const spawnGroupId = randomUUID();

      await db.insert(bot_request_cloud_agent_sessions).values([
        {
          bot_request_id: request.id,
          spawn_group_id: spawnGroupId,
          cloud_agent_session_id: 'agent_1',
          status: 'completed',
          terminal_at: new Date().toISOString(),
        },
        {
          bot_request_id: request.id,
          spawn_group_id: spawnGroupId,
          cloud_agent_session_id: 'agent_2',
          status: 'running',
        },
      ]);

      const claim = await claimCompletedBotRequestSessionGroup(request.id, spawnGroupId);
      expect(claim).toHaveLength(0);
    });
  });
});
