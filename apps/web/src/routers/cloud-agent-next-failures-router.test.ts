import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_agent_session_runs,
  cloud_agent_sessions,
  cli_sessions_v2,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';

const OWNER_ID = 'oauth/failures-history-owner';
const OTHER_USER_ID = 'oauth/failures-history-other';

const PERSONAL_SESSION_ID = 'agent_failures_history_personal';
const OTHER_SESSION_ID = 'agent_failures_history_other';

const DIAGNOSTIC_EXPIRES_AT = '2035-02-01T00:00:00.000Z';

const SESSION_IDS = [PERSONAL_SESSION_ID, OTHER_SESSION_ID];

describe('cloudAgentNextFailuresRouter', () => {
  let owner: User;
  let otherUser: User;
  let caller: Awaited<ReturnType<typeof createCallerForUser>>;

  beforeAll(async () => {
    owner = await insertTestUser({ id: OWNER_ID });
    otherUser = await insertTestUser({ id: OTHER_USER_ID });
    const [organization] = await db
      .insert(organizations)
      .values({
        name: 'Failure history scope test',
        created_by_kilo_user_id: owner.id,
      })
      .returning();

    await db
      .delete(cloud_agent_sessions)
      .where(inArray(cloud_agent_sessions.cloud_agent_session_id, SESSION_IDS));
    await db
      .delete(cli_sessions_v2)
      .where(inArray(cli_sessions_v2.cloud_agent_session_id, SESSION_IDS));

    await db.insert(cli_sessions_v2).values([
      {
        session_id: 'ses_failures_history_personal',
        cloud_agent_session_id: PERSONAL_SESSION_ID,
        kilo_user_id: owner.id,
        created_on_platform: 'cloud-agent-web',
        title: 'Failure history session',
        git_url: 'https://github.com/example/repo',
        created_at: '2035-01-09 23:00:00+00',
      },
      {
        session_id: 'ses_failures_history_org',
        cloud_agent_session_id: PERSONAL_SESSION_ID,
        organization_id: organization.id,
        kilo_user_id: otherUser.id,
        created_on_platform: 'cloud-agent-web',
      },
      {
        session_id: 'ses_failures_history_other',
        cloud_agent_session_id: OTHER_SESSION_ID,
        kilo_user_id: otherUser.id,
        created_on_platform: 'cloud-agent-web',
      },
    ]);

    await db.insert(cloud_agent_sessions).values([
      {
        cloud_agent_session_id: PERSONAL_SESSION_ID,
        kilo_session_id: 'ses_failures_history_personal',
        initial_message_id: 'msg_failures_history_initial',
        sandbox_id: 'usr_failures_history_sandbox',
        created_at: '2035-01-10 00:00:00+00',
        failure_at: '2035-01-10 00:06:00+00',
        failure_stage: 'initial_admission',
        failure_code: 'initial_admission_rejected',
        failure_responsibility: 'unknown',
        failure_reason: 'initial_admission_unknown',
        error_message_redacted: 'Initial admission failed',
        error_expires_at: DIAGNOSTIC_EXPIRES_AT,
      },
      {
        cloud_agent_session_id: OTHER_SESSION_ID,
        kilo_session_id: 'ses_failures_history_other',
        initial_message_id: 'msg_failures_history_other',
        created_at: '2035-01-10 00:00:00+00',
      },
    ]);

    await db.insert(cloud_agent_session_runs).values([
      {
        cloud_agent_session_id: PERSONAL_SESSION_ID,
        message_id: 'msg_failures_history_completed',
        status: 'completed',
        queued_at: '2035-01-10 00:01:00+00',
        terminal_at: '2035-01-10 00:02:00+00',
      },
      {
        cloud_agent_session_id: PERSONAL_SESSION_ID,
        message_id: 'msg_failures_history_failed',
        status: 'failed',
        queued_at: '2035-01-10 00:03:00+00',
        terminal_at: '2035-01-10 00:05:00+00',
        failure_stage: 'pre_dispatch',
        failure_code: 'wrapper_ping_timeout',
        failure_responsibility: 'platform',
        failure_reason: 'wrapper_liveness',
        error_message_redacted: 'Agent wrapper stopped responding after 30s',
        error_expires_at: DIAGNOSTIC_EXPIRES_AT,
        wrapper_run_id: 'wrapper_failures_history',
      },
      {
        cloud_agent_session_id: PERSONAL_SESSION_ID,
        message_id: 'msg_failures_history_expired',
        status: 'failed',
        queued_at: '2035-01-10 00:07:00+00',
        terminal_at: '2035-01-10 00:08:00+00',
        failure_stage: 'post_dispatch_no_activity',
        failure_code: 'wrapper_no_output',
        failure_responsibility: 'platform',
        failure_reason: 'wrapper_liveness',
        error_message_redacted: 'Expired diagnostic',
        error_expires_at: '2025-02-01 00:00:00+00',
      },
    ]);

    caller = await createCallerForUser(owner.id);
  });

  afterAll(async () => {
    await db
      .delete(cloud_agent_sessions)
      .where(inArray(cloud_agent_sessions.cloud_agent_session_id, SESSION_IDS));
    await db
      .delete(cli_sessions_v2)
      .where(inArray(cli_sessions_v2.cloud_agent_session_id, SESSION_IDS));
  });

  describe('getSessionFailureHistory', () => {
    it('returns the session identifiers, setup failure, and mapped run failures', async () => {
      const result = await caller.cloudAgentNextFailures.getSessionFailureHistory({
        cloudAgentSessionId: PERSONAL_SESSION_ID,
      });

      expect(result.session.cloudAgentSessionId).toBe(PERSONAL_SESSION_ID);
      expect(result.session.kiloSessionId).toBe('ses_failures_history_personal');
      expect(result.session.createdAt).toBe('2035-01-10T00:00:00.000Z');
      expect(result.session.sandboxId).toBe('usr_failures_history_sandbox');
      expect(result.session.organizationId).toBeNull();
      expect(result.session.title).toBe('Failure history session');
      expect(result.session.gitUrl).toBe('https://github.com/example/repo');
      expect(result.retention).toEqual({ runWindowDays: 90, diagnosticDays: 30 });

      expect(result.setupFailure).toEqual({
        occurredAt: '2035-01-10T00:06:00.000Z',
        stage: 'initial_admission',
        code: 'initial_admission_rejected',
        responsibility: 'unknown',
        reason: 'initial_admission_unknown',
        userVisibleError: 'Environment preparation failed (admission rejected)',
        diagnostic: 'Initial admission failed',
        diagnosticExpiresAt: '2035-02-01T00:00:00.000Z',
      });

      expect(result.runs).toHaveLength(3);
      expect(result.runs.map(run => run.messageId)).toEqual([
        'msg_failures_history_expired',
        'msg_failures_history_failed',
        'msg_failures_history_completed',
      ]);

      const failed = result.runs[1];
      expect(failed.status).toBe('failed');
      expect(failed.userVisibleError).toBe('Agent wrapper stopped responding');
      expect(failed.diagnostic).toBe('Agent wrapper stopped responding after 30s');
      expect(failed.terminalAt).toBe('2035-01-10T00:05:00.000Z');

      const expired = result.runs[0];
      expect(expired.diagnostic).toBeNull();
      expect(expired.diagnosticExpiresAt).toBeNull();

      const completed = result.runs[2];
      expect(completed.userVisibleError).toBeNull();
      expect(completed.diagnostic).toBeNull();
    });

    it('hides a foreign session', async () => {
      const otherCaller = await createCallerForUser(otherUser.id);
      await expect(
        otherCaller.cloudAgentNextFailures.getSessionFailureHistory({
          cloudAgentSessionId: PERSONAL_SESSION_ID,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('rejects unknown sessions', async () => {
      await expect(
        caller.cloudAgentNextFailures.getSessionFailureHistory({
          cloudAgentSessionId: 'agent_failures_history_unknown',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('exportSessionDiagnostics', () => {
    it('builds a JSON document with the support identifiers', async () => {
      const file = await caller.cloudAgentNextFailures.exportSessionDiagnostics({
        cloudAgentSessionId: PERSONAL_SESSION_ID,
        format: 'json',
      });

      expect(file.fileName).toBe('kilo-session-diagnostics-ses_failures_history_personal.json');
      expect(file.contentType).toBe('application/json');

      const document = JSON.parse(file.content) as {
        source: string;
        session: { cloudAgentSessionId: string; kiloSessionId: string };
        setupFailure: { occurredAt: string } | null;
        runs: Array<{ status: string; userVisibleError: string | null }>;
      };

      expect(document.source).toBe('kilo-cloud-session-diagnostics');
      expect(document.session.cloudAgentSessionId).toBe(PERSONAL_SESSION_ID);
      expect(document.session.kiloSessionId).toBe('ses_failures_history_personal');
      expect(document.setupFailure?.occurredAt).toBe('2035-01-10T00:06:00.000Z');
      expect(document.runs.filter(run => run.status === 'failed')).toHaveLength(2);
    });

    it('builds a CSV export with setup and run rows', async () => {
      const file = await caller.cloudAgentNextFailures.exportSessionDiagnostics({
        cloudAgentSessionId: PERSONAL_SESSION_ID,
        format: 'csv',
      });

      expect(file.contentType).toBe('text/csv');

      const lines = file.content.trimEnd().split('\n');
      expect(lines[0]).toContain('source,occurred_at,status,stage,code');
      expect(lines).toHaveLength(4);
      expect(lines[1]).toContain('setup');
      expect(lines[2]).toContain('run');
    });
  });
});
