import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_agent_session_runs,
  cloud_agent_sessions,
  kilocode_users,
  type User,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

const START_DATE = '2035-01-10T00:00:00.000Z';
const END_DATE = '2035-01-11T00:00:00.000Z';
const RAW_CREATED_TIME = '2035-01-10 00:00:00+00';
const ids = {
  mapped: 'agent_admin_outcomes_mapped',
  setupFailed: 'agent_admin_outcomes_setup_failed',
  setupFailedLater: 'agent_admin_outcomes_setup_failed_later',
  unmapped: 'agent_admin_outcomes_unmapped',
  expired: 'agent_admin_outcomes_expired',
};

function interval(overrides: Partial<{ startDate: string; endDate: string }> = {}) {
  return { startDate: START_DATE, endDate: END_DATE, ...overrides };
}

function at(hours: number, minutes: number = 0, seconds: number = 0) {
  return new Date(Date.UTC(2035, 0, 10, hours, minutes, seconds)).toISOString();
}

describe('adminCloudAgentNextRouter', () => {
  let adminUser: User;
  let regularUser: User;

  beforeAll(async () => {
    adminUser = await insertTestUser({
      google_user_email: `admin-cloud-agent-outcomes-${Date.now()}@example.com`,
      is_admin: true,
    });
    regularUser = await insertTestUser({
      google_user_email: `regular-cloud-agent-outcomes-${Date.now()}@example.com`,
    });
  });

  beforeEach(async () => {
    await db.insert(cloud_agent_sessions).values([
      {
        cloud_agent_session_id: ids.mapped,
        kilo_session_id: 'ses_admin_outcomes_mapped',
        initial_message_id: 'msg_admin_initial',
        created_at: RAW_CREATED_TIME,
      },
      {
        cloud_agent_session_id: ids.setupFailed,
        kilo_session_id: 'ses_admin_setup_failed',
        initial_message_id: 'msg_setup_failed',
        created_at: '2035-01-09T23:56:00.000Z',
        failure_at: at(0, 6),
        failure_stage: 'initial_admission',
        failure_code: 'initial_admission_rejected',
        failure_responsibility: 'unknown',
        failure_reason: 'initial_admission_unknown',
      },
      {
        cloud_agent_session_id: ids.setupFailedLater,
        kilo_session_id: 'ses_admin_setup_failed_later',
        initial_message_id: 'msg_setup_failed_later',
        created_at: at(5),
        failure_at: at(5, 1),
        failure_stage: 'initial_admission',
        failure_code: 'invalid_initial_intent',
        failure_responsibility: 'user',
        failure_reason: 'initial_request_invalid',
      },
      {
        cloud_agent_session_id: ids.unmapped,
        kilo_session_id: 'ses_admin_outcomes_unmapped',
        initial_message_id: 'msg_unmapped_initial',
        created_at: at(0, 15),
      },
      {
        cloud_agent_session_id: ids.expired,
        kilo_session_id: 'ses_admin_outcomes_expired',
        initial_message_id: 'msg_expired_initial',
        created_at: '2025-01-10T00:20:00.000Z',
      },
    ]);
    await db.insert(cloud_agent_session_runs).values([
      {
        cloud_agent_session_id: ids.mapped,
        message_id: 'msg_admin_initial',
        status: 'completed',
        terminal_at: at(1, 1),
      },
      {
        cloud_agent_session_id: ids.mapped,
        message_id: 'msg_admin_failed_predispatch',
        status: 'failed',
        terminal_at: at(2, 2),
        failure_stage: 'pre_dispatch',
        failure_code: 'sandbox_connect_failed',
        failure_responsibility: 'platform',
        failure_reason: 'sandbox_connectivity',
      },
      {
        cloud_agent_session_id: ids.setupFailed,
        message_id: 'msg_admin_failed_after_dispatch',
        status: 'failed',
        terminal_at: at(3, 0, 40),
        failure_stage: 'agent_activity',
        failure_code: 'payment_required',
        failure_responsibility: 'user',
        failure_reason: 'insufficient_credits',
      },
      {
        cloud_agent_session_id: ids.unmapped,
        message_id: 'msg_admin_interrupted',
        status: 'interrupted',
        terminal_at: at(4, 5),
        failure_stage: 'interruption',
        failure_code: 'user_interrupt',
      },
      {
        cloud_agent_session_id: ids.expired,
        message_id: 'msg_admin_expired_failed',
        status: 'failed',
        terminal_at: at(2, 31),
        failure_stage: 'pre_dispatch',
        failure_code: 'wrapper_start_failed',
      },
    ]);
  });

  afterEach(async () => {
    await db
      .delete(cloud_agent_sessions)
      .where(inArray(cloud_agent_sessions.cloud_agent_session_id, Object.values(ids)));
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, adminUser.id));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, regularUser.id));
  });

  it('requires admin access and rejects invalid or overlong intervals', async () => {
    const regularCaller = await createCallerForUser(regularUser.id);
    const adminCaller = await createCallerForUser(adminUser.id);
    await expect(regularCaller.admin.cloudAgentNext.getHealthOverview(interval())).rejects.toThrow(
      'Admin access required'
    );
    await expect(
      regularCaller.admin.cloudAgentNext.listHealthErrorSessions({
        ...interval(),
        source: 'run',
        stage: 'pre_dispatch',
        code: 'sandbox_connect_failed',
        responsibility: 'platform',
        reason: 'sandbox_connectivity',
      })
    ).rejects.toThrow('Admin access required');
    await expect(
      adminCaller.admin.cloudAgentNext.getHealthOverview({
        startDate: END_DATE,
        endDate: END_DATE,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      adminCaller.admin.cloudAgentNext.getHealthOverview({
        startDate: START_DATE,
        endDate: '2035-04-11T00:00:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('summarizes health and ranks operational errors without interruptions', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview(interval());

    expect(health.summary).toEqual({
      completedRuns: 1,
      failedRuns: 2,
      interruptedRuns: 1,
      setupFailures: 2,
      platformFailures: 1,
      userFailures: 2,
      unknownFailures: 1,
      platformFailureRate: 0.5,
      allFailureRate: 0.8,
    });
    expect(health.topErrors).toEqual(
      expect.arrayContaining([
        {
          source: 'setup',
          stage: 'initial_admission',
          code: 'initial_admission_rejected',
          responsibility: 'unknown',
          reason: 'initial_admission_unknown',
          count: 1,
        },
        {
          source: 'run',
          stage: 'pre_dispatch',
          code: 'sandbox_connect_failed',
          responsibility: 'platform',
          reason: 'sandbox_connectivity',
          count: 1,
        },
        {
          source: 'run',
          stage: 'agent_activity',
          code: 'payment_required',
          responsibility: 'user',
          reason: 'insufficient_credits',
          count: 1,
        },
      ])
    );
    expect(JSON.stringify(health.topErrors)).not.toContain('user_interrupt');
    expect(JSON.stringify(health.topErrors)).not.toContain('wrapper_start_failed');
  });

  it('excludes runs whose session falls outside the 90-day retention window', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview(interval());

    expect(health.summary.failedRuns).toBe(2);
    expect(health.summary.completedRuns).toBe(1);
    expect(JSON.stringify(health.topErrors)).not.toContain('wrapper_start_failed');
  });

  it('filters top errors by responsibility without changing visible summary counts', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview({
      ...interval(),
      responsibility: 'platform',
    });

    expect(health.summary).toMatchObject({
      platformFailures: 1,
      userFailures: 2,
      unknownFailures: 1,
    });
    expect(health.topErrors).toEqual([
      expect.objectContaining({
        responsibility: 'platform',
        reason: 'sandbox_connectivity',
      }),
    ]);
  });

  it('returns null rates when there are no assessed outcomes', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview({
      startDate: '2035-01-12T00:00:00.000Z',
      endDate: '2035-01-13T00:00:00.000Z',
    });
    expect(health.summary.platformFailureRate).toBeNull();
    expect(health.summary.allFailureRate).toBeNull();
  });

  it('lists affected sessions for an exact top-error source and occurrence interval', async () => {
    await db.insert(cloud_agent_session_runs).values([
      {
        cloud_agent_session_id: ids.unmapped,
        message_id: 'msg_admin_failed_unclassified',
        status: 'failed',
        terminal_at: at(6, 1),
      },
      {
        cloud_agent_session_id: ids.setupFailedLater,
        message_id: 'msg_admin_failed_explicit_unclassified',
        status: 'failed',
        terminal_at: at(6, 2),
        failure_stage: 'unknown',
        failure_code: 'unclassified',
      },
      {
        cloud_agent_session_id: ids.mapped,
        message_id: 'msg_admin_managed_provider_unavailable',
        status: 'failed',
        terminal_at: at(7, 1),
        failure_stage: 'agent_activity',
        failure_code: 'assistant_error',
        failure_responsibility: 'platform',
        failure_reason: 'managed_provider_unavailable',
      },
      {
        cloud_agent_session_id: ids.unmapped,
        message_id: 'msg_admin_user_rate_limited',
        status: 'failed',
        terminal_at: at(7, 2),
        failure_stage: 'agent_activity',
        failure_code: 'assistant_error',
        failure_responsibility: 'user',
        failure_reason: 'rate_limited',
      },
    ]);
    const caller = await createCallerForUser(adminUser.id);
    const setupSessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      source: 'setup',
      stage: 'initial_admission',
      code: 'initial_admission_rejected',
      responsibility: 'unknown',
      reason: 'initial_admission_unknown',
    });
    const runSessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      source: 'run',
      stage: 'pre_dispatch',
      code: 'sandbox_connect_failed',
      responsibility: 'platform',
      reason: 'sandbox_connectivity',
    });
    const unclassifiedSessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      source: 'run',
      stage: 'unknown',
      code: 'unclassified',
      responsibility: 'unknown',
      reason: 'unclassified',
    });
    const managedProviderSessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      source: 'run',
      stage: 'agent_activity',
      code: 'assistant_error',
      responsibility: 'platform',
      reason: 'managed_provider_unavailable',
    });

    expect(setupSessions.totalSessions).toBe(1);
    expect(setupSessions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudAgentSessionId: ids.setupFailed,
          kiloSessionId: 'ses_admin_setup_failed',
          occurredAt: at(0, 6),
          matchingEvents: 1,
        }),
      ])
    );
    expect(runSessions).toMatchObject({
      totalSessions: 1,
      limit: 100,
      rows: [
        expect.objectContaining({
          cloudAgentSessionId: ids.mapped,
          kiloSessionId: 'ses_admin_outcomes_mapped',
          occurredAt: at(2, 2),
          matchingEvents: 1,
        }),
      ],
    });
    expect(JSON.stringify(runSessions)).not.toContain(ids.setupFailed);
    expect(unclassifiedSessions.totalSessions).toBe(2);
    expect(unclassifiedSessions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudAgentSessionId: ids.unmapped,
          occurredAt: at(6, 1),
          matchingEvents: 1,
        }),
        expect.objectContaining({
          cloudAgentSessionId: ids.setupFailedLater,
          occurredAt: at(6, 2),
          matchingEvents: 1,
        }),
      ])
    );
    expect(managedProviderSessions).toMatchObject({
      totalSessions: 1,
      rows: [expect.objectContaining({ cloudAgentSessionId: ids.mapped, matchingEvents: 1 })],
    });
    expect(JSON.stringify(managedProviderSessions)).not.toContain(ids.unmapped);
  });
});
