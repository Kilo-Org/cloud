import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_agent_session_runs,
  cloud_agent_sessions,
  kilocode_users,
  type User,
} from '@kilocode/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

const START_DATE = '2035-01-10T00:00:00.000Z';
const END_DATE = '2035-01-11T00:00:00.000Z';
const RAW_CREATED_TIME = '2035-01-10 00:00:00+00';
const SHARED_SANDBOX_ID = 'usr_admin_outcomes_shared';
const DIAGNOSTIC_EXPIRES_AT = '2035-02-01T00:00:00.000Z';
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

const matchingRun = {
  cloud_agent_session_id: ids.mapped,
  status: 'failed',
  terminal_at: at(8),
  failure_stage: 'pre_dispatch',
  failure_code: 'sandbox_connect_failed',
  failure_responsibility: 'platform',
  failure_reason: 'sandbox_connectivity',
} as const;

const matchingError = {
  source: 'run',
  stage: matchingRun.failure_stage,
  code: matchingRun.failure_code,
  responsibility: matchingRun.failure_responsibility,
  reason: matchingRun.failure_reason,
} as const;

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
        sandbox_id: SHARED_SANDBOX_ID,
        created_at: RAW_CREATED_TIME,
      },
      {
        cloud_agent_session_id: ids.setupFailed,
        kilo_session_id: 'ses_admin_setup_failed',
        initial_message_id: 'msg_setup_failed',
        sandbox_id: SHARED_SANDBOX_ID,
        created_at: '2035-01-09T23:56:00.000Z',
        failure_at: '2035-01-10 00:06:00+00',
        failure_stage: 'initial_admission',
        failure_code: 'initial_admission_rejected',
        failure_responsibility: 'unknown',
        failure_reason: 'initial_admission_unknown',
        error_message_redacted: 'Initial admission failed',
        error_expires_at: DIAGNOSTIC_EXPIRES_AT,
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
        sandbox_id: 'usr_admin_outcomes_expired',
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
        wrapper_run_id: 'wrapper_admin_original',
        error_message_redacted: 'Sandbox connection failed',
        error_expires_at: DIAGNOSTIC_EXPIRES_AT,
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
    for (const invalidInterval of [
      { startDate: END_DATE, endDate: END_DATE },
      { startDate: END_DATE, endDate: START_DATE },
      { startDate: START_DATE, endDate: '2035-04-11T00:00:00.000Z' },
      { startDate: RAW_CREATED_TIME, endDate: END_DATE },
    ]) {
      await expect(
        adminCaller.admin.cloudAgentNext.getHealthOverview(invalidInterval)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        adminCaller.admin.cloudAgentNext.listHealthErrorSessions({
          ...invalidInterval,
          ...matchingError,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
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
          affectedSessions: 1,
          knownSandboxes: 1,
          sessionsWithoutSandbox: 0,
        },
        {
          source: 'setup',
          stage: 'initial_admission',
          code: 'invalid_initial_intent',
          responsibility: 'user',
          reason: 'initial_request_invalid',
          count: 1,
          affectedSessions: 1,
          knownSandboxes: 0,
          sessionsWithoutSandbox: 1,
        },
        {
          source: 'run',
          stage: 'pre_dispatch',
          code: 'sandbox_connect_failed',
          responsibility: 'platform',
          reason: 'sandbox_connectivity',
          count: 1,
          affectedSessions: 1,
          knownSandboxes: 1,
          sessionsWithoutSandbox: 0,
        },
        {
          source: 'run',
          stage: 'agent_activity',
          code: 'payment_required',
          responsibility: 'user',
          reason: 'insufficient_credits',
          count: 1,
          affectedSessions: 1,
          knownSandboxes: 1,
          sessionsWithoutSandbox: 0,
        },
      ])
    );
    expect(JSON.stringify(health.topErrors)).not.toContain('user_interrupt');
    expect(JSON.stringify(health.topErrors)).not.toContain('wrapper_start_failed');
  });

  it('counts distinct affected sessions and known sandboxes without multiplying setup failures', async () => {
    await db.insert(cloud_agent_session_runs).values(
      [
        ids.mapped,
        ids.mapped,
        ids.setupFailed,
        ids.unmapped,
        ids.unmapped,
        ids.setupFailedLater,
        ids.expired,
      ].map((sessionId, index) => ({
        ...matchingRun,
        cloud_agent_session_id: sessionId,
        message_id: `msg_admin_repeated_${index}`,
      }))
    );
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview(interval());
    const sessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      ...matchingError,
    });

    expect(health.topErrors).toEqual(
      expect.arrayContaining([
        {
          ...matchingError,
          count: 7,
          affectedSessions: 4,
          knownSandboxes: 1,
          sessionsWithoutSandbox: 2,
        },
        expect.objectContaining({
          source: 'setup',
          reason: 'initial_admission_unknown',
          count: 1,
          affectedSessions: 1,
          knownSandboxes: 1,
          sessionsWithoutSandbox: 0,
        }),
        expect.objectContaining({
          source: 'setup',
          reason: 'initial_request_invalid',
          count: 1,
          affectedSessions: 1,
          knownSandboxes: 0,
          sessionsWithoutSandbox: 1,
        }),
      ])
    );
    expect(sessions.totalSessions).toBe(4);
    expect(sessions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudAgentSessionId: ids.mapped,
          matchingEvents: 3,
          sandboxId: SHARED_SANDBOX_ID,
        }),
        expect.objectContaining({
          cloudAgentSessionId: ids.unmapped,
          matchingEvents: 2,
          sandboxId: null,
        }),
      ])
    );
    expect(sessions.rows).toHaveLength(4);
    expect(health.summary.setupFailures).toBe(2);
    expect(health.errorTotals).toEqual({ groups: 4, events: 10 });
  });

  it('excludes runs whose session falls outside the 90-day retention window', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview(interval());

    expect(health.summary.failedRuns).toBe(2);
    expect(health.summary.completedRuns).toBe(1);
    expect(JSON.stringify(health.topErrors)).not.toContain('wrapper_start_failed');
  });

  it.each([
    { responsibility: 'platform', events: 1, groups: 1 },
    { responsibility: 'user', events: 2, groups: 2 },
    { responsibility: 'unknown', events: 1, groups: 1 },
  ] as const)(
    'filters top errors by $responsibility without changing the global summary',
    async ({ responsibility, events, groups }) => {
      const caller = await createCallerForUser(adminUser.id);
      const allHealth = await caller.admin.cloudAgentNext.getHealthOverview(interval());
      const health = await caller.admin.cloudAgentNext.getHealthOverview({
        ...interval(),
        responsibility,
      });

      expect(health.summary).toEqual(allHealth.summary);
      expect(health.topErrors).toEqual(
        allHealth.topErrors.filter(error => error.responsibility === responsibility)
      );
      expect(health.errorTotals).toEqual({ events, groups });
      expect(allHealth.errorTotals).toEqual({ events: 4, groups: 4 });
    }
  );

  it('reports all matching groups and events even when only the top ten are returned', async () => {
    const failures = [
      ['pre_dispatch', 'workspace_setup_failed', 'platform', 'sandbox_capacity'],
      ['pre_dispatch', 'workspace_setup_failed', 'user', 'source_control_authentication'],
      ['pre_dispatch', 'workspace_setup_failed', 'unknown', 'source_control_network'],
      ['pre_dispatch', 'wrapper_start_failed', 'platform', 'runtime_startup'],
      ['pre_dispatch', 'kilo_server_failed', 'platform', 'runtime_startup'],
      ['pre_dispatch', 'delivery_failure_unknown', 'platform', 'delivery'],
      ['post_dispatch_no_activity', 'wrapper_ping_timeout', 'platform', 'wrapper_liveness'],
      ['agent_activity', 'assistant_error', 'platform', 'managed_provider_unavailable'],
      ['agent_activity', 'assistant_error', 'unknown', 'assistant_unknown'],
    ] as const;
    await db.insert(cloud_agent_session_runs).values([
      ...failures.map(([stage, code, responsibility, reason], index) => ({
        ...matchingRun,
        message_id: `msg_admin_group_${index}`,
        failure_stage: stage,
        failure_code: code,
        failure_responsibility: responsibility,
        failure_reason: reason,
      })),
      { ...matchingRun, message_id: 'msg_admin_top_group_repeat_1' },
      { ...matchingRun, message_id: 'msg_admin_top_group_repeat_2' },
    ]);
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview(interval());
    const platformHealth = await caller.admin.cloudAgentNext.getHealthOverview({
      ...interval(),
      responsibility: 'platform',
    });

    expect(health.errorTotals).toEqual({ groups: 13, events: 15 });
    expect(health.topErrors).toHaveLength(10);
    expect(health.topErrors[0]).toMatchObject({ ...matchingError, count: 3 });
    expect(health.topErrors.reduce((total, error) => total + error.count, 0)).toBe(12);
    expect(platformHealth.errorTotals).toEqual({ groups: 7, events: 9 });
    expect(platformHealth.topErrors).toHaveLength(7);
    expect(platformHealth.summary).toEqual(health.summary);
  });

  it('returns null rates when there are no assessed outcomes', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview({
      startDate: '2035-01-12T00:00:00.000Z',
      endDate: '2035-01-13T00:00:00.000Z',
    });
    expect(health.summary.platformFailureRate).toBeNull();
    expect(health.summary.allFailureRate).toBeNull();
    expect(health.topErrors).toEqual([]);
    expect(health.errorTotals).toEqual({ events: 0, groups: 0 });
  });

  it('keeps inclusive start and exclusive end boundaries for counts and matching details', async () => {
    await db
      .update(cloud_agent_session_runs)
      .set({ terminal_at: START_DATE })
      .where(
        and(
          eq(cloud_agent_session_runs.cloud_agent_session_id, ids.mapped),
          eq(cloud_agent_session_runs.message_id, 'msg_admin_failed_predispatch')
        )
      );
    await db.insert(cloud_agent_session_runs).values([
      { ...matchingRun, message_id: 'msg_at_interval_end', terminal_at: END_DATE },
      {
        ...matchingRun,
        message_id: 'msg_before_interval',
        terminal_at: '2035-01-09T23:59:59.999Z',
      },
      { ...matchingRun, message_id: 'msg_without_terminal_time', terminal_at: null },
    ]);
    await db
      .update(cloud_agent_sessions)
      .set({ failure_at: END_DATE })
      .where(eq(cloud_agent_sessions.cloud_agent_session_id, ids.setupFailedLater));
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview(interval());
    const sessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      ...matchingError,
    });

    expect(health.topErrors).toContainEqual({
      ...matchingError,
      count: 1,
      affectedSessions: 1,
      knownSandboxes: 1,
      sessionsWithoutSandbox: 0,
    });
    expect(health.summary.setupFailures).toBe(1);
    expect(sessions.rows).toEqual([
      expect.objectContaining({
        messageId: 'msg_admin_failed_predispatch',
        lastSeen: START_DATE,
        matchingEvents: 1,
      }),
    ]);
  });

  it.each([
    [null, 'assistant_error', 'unknown', 'assistant_error'],
    ['agent_activity', null, 'agent_activity', 'unclassified'],
    [null, 'unclassified', 'unknown', 'unclassified'],
    ['unknown', null, 'unknown', 'unclassified'],
  ] as const)(
    'matches partially classified runs (%s, %s) with overview normalization',
    async (storedStage, storedCode, stage, code) => {
      await db.insert(cloud_agent_session_runs).values([
        {
          ...matchingRun,
          cloud_agent_session_id: ids.unmapped,
          message_id: 'msg_partial_classification',
          failure_stage: storedStage,
          failure_code: storedCode,
          failure_responsibility: null,
          failure_reason: null,
        },
        {
          ...matchingRun,
          cloud_agent_session_id: ids.unmapped,
          message_id: 'msg_explicit_classification',
          terminal_at: at(7),
          failure_stage: stage,
          failure_code: code,
          failure_responsibility: 'unknown',
          failure_reason: 'unclassified',
        },
      ]);
      const caller = await createCallerForUser(adminUser.id);
      const error = {
        source: 'run',
        stage,
        code,
        responsibility: 'unknown',
        reason: 'unclassified',
      } as const;
      const health = await caller.admin.cloudAgentNext.getHealthOverview(interval());
      const sessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
        ...interval(),
        ...error,
      });

      expect(health.topErrors).toContainEqual({
        ...error,
        count: 2,
        affectedSessions: 1,
        knownSandboxes: 0,
        sessionsWithoutSandbox: 1,
      });
      expect(sessions).toMatchObject({
        totalSessions: 1,
        rows: [
          {
            cloudAgentSessionId: ids.unmapped,
            messageId: 'msg_partial_classification',
            lastSeen: at(8),
            matchingEvents: 2,
          },
        ],
      });
    }
  );

  it('limits the drilldown to the latest 100 sessions without truncating totals or event counts', async () => {
    const sessionIds = Array.from(
      { length: 101 },
      (_, index) => `agent_admin_outcomes_limit_${index.toString().padStart(3, '0')}`
    );
    try {
      await db.insert(cloud_agent_sessions).values(
        sessionIds.map(sessionId => ({
          cloud_agent_session_id: sessionId,
          kilo_session_id: `ses_${sessionId}`,
          initial_message_id: `msg_${sessionId}`,
          created_at: RAW_CREATED_TIME,
        }))
      );
      await db.insert(cloud_agent_session_runs).values([
        ...sessionIds.map(sessionId => ({
          ...matchingRun,
          cloud_agent_session_id: sessionId,
          message_id: `msg_${sessionId}`,
        })),
        {
          ...matchingRun,
          cloud_agent_session_id: sessionIds[100],
          message_id: 'msg_limit_repeated',
          terminal_at: at(9),
        },
      ]);
      const caller = await createCallerForUser(adminUser.id);
      const sessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
        ...interval(),
        ...matchingError,
      });

      expect(sessions.totalSessions).toBe(102);
      expect(sessions.limit).toBe(100);
      expect(sessions.rows.map(row => row.cloudAgentSessionId)).toEqual(
        [...sessionIds].reverse().slice(0, 100)
      );
      expect(sessions.rows[0]).toMatchObject({
        messageId: 'msg_limit_repeated',
        lastSeen: at(9),
        matchingEvents: 2,
      });
    } finally {
      await db
        .delete(cloud_agent_sessions)
        .where(inArray(cloud_agent_sessions.cloud_agent_session_id, sessionIds));
    }
  });

  it('pairs details from the latest matching run using terminal time and message ID ties', async () => {
    await db.insert(cloud_agent_session_runs).values([
      {
        ...matchingRun,
        message_id: 'msg_zz_older',
        terminal_at: at(7),
        wrapper_run_id: 'wrapper_zz_older',
        error_message_redacted: 'Z older diagnostic',
        error_expires_at: DIAGNOSTIC_EXPIRES_AT,
      },
      {
        ...matchingRun,
        message_id: 'msg_tied_a',
        wrapper_run_id: 'wrapper_z_tied',
        error_message_redacted: 'B tied diagnostic',
        error_expires_at: DIAGNOSTIC_EXPIRES_AT,
      },
      {
        ...matchingRun,
        message_id: 'msg_tied_b',
        terminal_at: '2035-01-10 08:00:00+00',
        wrapper_run_id: 'wrapper_a_selected',
        error_message_redacted: 'A selected diagnostic',
        error_expires_at: '2035-01-30 12:00:00+00',
      },
      {
        ...matchingRun,
        message_id: 'msg_newer_other_reason',
        terminal_at: at(9),
        failure_reason: 'runtime_startup',
        wrapper_run_id: 'wrapper_other_reason',
        error_message_redacted: 'Other reason diagnostic',
        error_expires_at: DIAGNOSTIC_EXPIRES_AT,
      },
      {
        ...matchingRun,
        message_id: 'msg_newer_completed',
        terminal_at: at(10),
        status: 'completed',
      },
      {
        ...matchingRun,
        message_id: 'msg_outside_interval',
        terminal_at: END_DATE,
      },
    ]);
    const caller = await createCallerForUser(adminUser.id);
    const sessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      ...matchingError,
    });

    expect(sessions).toEqual({
      totalSessions: 1,
      limit: 100,
      rows: [
        {
          cloudAgentSessionId: ids.mapped,
          kiloSessionId: 'ses_admin_outcomes_mapped',
          sandboxId: SHARED_SANDBOX_ID,
          messageId: 'msg_tied_b',
          wrapperRunId: 'wrapper_a_selected',
          diagnostic: 'A selected diagnostic',
          diagnosticExpiresAt: '2035-01-30T12:00:00.000Z',
          occurredAt: at(8),
          lastSeen: at(8),
          matchingEvents: 4,
        },
      ],
    });
  });

  it.each([
    {
      name: 'expired',
      diagnostic: 'Expired run diagnostic',
      expiresAt: '2000-01-01T00:00:00.000Z',
    },
    { name: 'missing', diagnostic: null, expiresAt: null },
  ] as const)(
    'keeps the latest run when its diagnostic is $name without returning older text',
    async ({ diagnostic, expiresAt }) => {
      await db.insert(cloud_agent_session_runs).values({
        ...matchingRun,
        message_id: 'msg_admin_latest_without_diagnostic',
        error_message_redacted: diagnostic,
        error_expires_at: expiresAt,
      });
      const caller = await createCallerForUser(adminUser.id);
      const sessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
        ...interval(),
        ...matchingError,
      });
      const health = await caller.admin.cloudAgentNext.getHealthOverview(interval());

      expect(sessions.rows).toEqual([
        expect.objectContaining({
          messageId: 'msg_admin_latest_without_diagnostic',
          wrapperRunId: null,
          diagnostic: null,
          diagnosticExpiresAt: expiresAt,
          lastSeen: at(8),
          matchingEvents: 2,
        }),
      ]);
      expect(JSON.stringify(sessions)).not.toContain('Expired run diagnostic');
      expect(JSON.stringify(sessions)).not.toContain('Sandbox connection failed');
      expect(health.topErrors).toContainEqual({
        ...matchingError,
        count: 2,
        affectedSessions: 1,
        knownSandboxes: 1,
        sessionsWithoutSandbox: 0,
      });
      expect(health.summary.failedRuns).toBe(3);
    }
  );

  it('rejects retained diagnostic text without an expiry', async () => {
    await expect(
      db.insert(cloud_agent_session_runs).values({
        ...matchingRun,
        message_id: 'msg_unexpiring_diagnostic',
        error_message_redacted: 'Diagnostic requiring expiry',
        error_expires_at: null,
      })
    ).rejects.toMatchObject({
      cause: { constraint: 'cloud_agent_session_runs_error_expiry_check' },
    });
  });

  it.each([
    {
      name: 'expired',
      diagnostic: 'Expired setup diagnostic',
      expiresAt: '2000-01-01T00:00:00.000Z',
    },
    { name: 'missing', diagnostic: null, expiresAt: null },
  ])(
    'keeps setup counts and initial message IDs when the diagnostic is $name',
    async ({ diagnostic, expiresAt }) => {
      await db
        .update(cloud_agent_sessions)
        .set({ error_message_redacted: diagnostic, error_expires_at: expiresAt })
        .where(eq(cloud_agent_sessions.cloud_agent_session_id, ids.setupFailed));
      const caller = await createCallerForUser(adminUser.id);
      const sessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
        ...interval(),
        source: 'setup',
        stage: 'initial_admission',
        code: 'initial_admission_rejected',
        responsibility: 'unknown',
        reason: 'initial_admission_unknown',
      });
      const health = await caller.admin.cloudAgentNext.getHealthOverview(interval());

      expect(sessions).toMatchObject({
        totalSessions: 1,
        rows: [
          {
            cloudAgentSessionId: ids.setupFailed,
            messageId: 'msg_setup_failed',
            wrapperRunId: null,
            diagnostic: null,
            diagnosticExpiresAt: expiresAt,
            lastSeen: at(0, 6),
            matchingEvents: 1,
          },
        ],
      });
      expect(JSON.stringify(sessions)).not.toContain('Expired setup diagnostic');
      expect(health.summary.setupFailures).toBe(2);
      expect(health.topErrors).toContainEqual(
        expect.objectContaining({ source: 'setup', reason: 'initial_admission_unknown', count: 1 })
      );
    }
  );

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
          sandboxId: SHARED_SANDBOX_ID,
          messageId: 'msg_setup_failed',
          wrapperRunId: null,
          diagnostic: 'Initial admission failed',
          diagnosticExpiresAt: DIAGNOSTIC_EXPIRES_AT,
          occurredAt: at(0, 6),
          lastSeen: at(0, 6),
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
          sandboxId: SHARED_SANDBOX_ID,
          messageId: 'msg_admin_failed_predispatch',
          wrapperRunId: 'wrapper_admin_original',
          diagnostic: 'Sandbox connection failed',
          diagnosticExpiresAt: DIAGNOSTIC_EXPIRES_AT,
          occurredAt: at(2, 2),
          lastSeen: at(2, 2),
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
          sandboxId: null,
          messageId: 'msg_admin_failed_unclassified',
          wrapperRunId: null,
          diagnostic: null,
          diagnosticExpiresAt: null,
          occurredAt: at(6, 1),
          lastSeen: at(6, 1),
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
