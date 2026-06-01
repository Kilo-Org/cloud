import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cli_sessions_v2,
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
      },
      {
        cloud_agent_session_id: ids.setupFailedLater,
        kilo_session_id: 'ses_admin_setup_failed_later',
        initial_message_id: 'msg_setup_failed_later',
        created_at: at(5),
        failure_at: at(5, 1),
        failure_stage: 'initial_admission',
        failure_code: 'initial_admission_rejected',
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
    await db.insert(cli_sessions_v2).values([
      {
        session_id: 'ses_admin_outcomes_mapped',
        kilo_user_id: adminUser.id,
        cloud_agent_session_id: ids.mapped,
        created_on_platform: 'vscode',
      },
      {
        session_id: 'ses_admin_setup_failed_later',
        kilo_user_id: adminUser.id,
        cloud_agent_session_id: ids.setupFailedLater,
        created_on_platform: ' code-review ',
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
        failure_code: 'workspace_setup_failed',
      },
      {
        cloud_agent_session_id: ids.setupFailed,
        message_id: 'msg_admin_failed_after_dispatch',
        status: 'failed',
        terminal_at: at(3, 0, 40),
        failure_stage: 'agent_activity',
        failure_code: 'assistant_error',
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
    await db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.kilo_user_id, adminUser.id));
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
    await expect(regularCaller.admin.cloudAgentNext.listHealthPlatforms()).rejects.toThrow(
      'Admin access required'
    );
    await expect(
      regularCaller.admin.cloudAgentNext.getHealthOverview({ ...interval(), bucket: 'hour' })
    ).rejects.toThrow('Admin access required');
    await expect(
      regularCaller.admin.cloudAgentNext.listHealthErrorSessions({
        ...interval(),
        source: 'run',
        stage: 'pre_dispatch',
        code: 'workspace_setup_failed',
      })
    ).rejects.toThrow('Admin access required');
    await expect(
      adminCaller.admin.cloudAgentNext.getHealthOverview({
        ...interval({ startDate: END_DATE, endDate: END_DATE }),
        bucket: 'hour',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      adminCaller.admin.cloudAgentNext.getHealthOverview({
        ...interval({ endDate: '2035-04-11T00:00:00.000Z' }),
        bucket: 'day',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('summarizes hourly health and ranks operational errors without interruptions', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview({
      ...interval(),
      bucket: 'hour',
    });

    expect(health.summary).toEqual({
      completedRuns: 1,
      failedRuns: 2,
      interruptedRuns: 1,
      setupFailures: 2,
    });
    expect(health.series).toHaveLength(24);
    expect(health.series.slice(0, 7)).toEqual([
      {
        bucketStart: '2035-01-10T00:00:00.000Z',
        completedRuns: 0,
        failedRuns: 0,
        interruptedRuns: 0,
        setupFailures: 1,
      },
      {
        bucketStart: '2035-01-10T01:00:00.000Z',
        completedRuns: 1,
        failedRuns: 0,
        interruptedRuns: 0,
        setupFailures: 0,
      },
      {
        bucketStart: '2035-01-10T02:00:00.000Z',
        completedRuns: 0,
        failedRuns: 1,
        interruptedRuns: 0,
        setupFailures: 0,
      },
      {
        bucketStart: '2035-01-10T03:00:00.000Z',
        completedRuns: 0,
        failedRuns: 1,
        interruptedRuns: 0,
        setupFailures: 0,
      },
      {
        bucketStart: '2035-01-10T04:00:00.000Z',
        completedRuns: 0,
        failedRuns: 0,
        interruptedRuns: 1,
        setupFailures: 0,
      },
      {
        bucketStart: '2035-01-10T05:00:00.000Z',
        completedRuns: 0,
        failedRuns: 0,
        interruptedRuns: 0,
        setupFailures: 1,
      },
      {
        bucketStart: '2035-01-10T06:00:00.000Z',
        completedRuns: 0,
        failedRuns: 0,
        interruptedRuns: 0,
        setupFailures: 0,
      },
    ]);
    expect(health.topErrors).toEqual(
      expect.arrayContaining([
        {
          source: 'setup',
          stage: 'initial_admission',
          code: 'initial_admission_rejected',
          count: 2,
        },
        { source: 'run', stage: 'pre_dispatch', code: 'workspace_setup_failed', count: 1 },
        { source: 'run', stage: 'agent_activity', code: 'assistant_error', count: 1 },
      ])
    );
    expect(JSON.stringify(health.topErrors)).not.toContain('user_interrupt');
    expect(JSON.stringify(health.topErrors)).not.toContain('wrapper_start_failed');
  });

  it('filters health and error drilldowns by exact or unknown created platform', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const platforms = await caller.admin.cloudAgentNext.listHealthPlatforms();
    const vscodeHealth = await caller.admin.cloudAgentNext.getHealthOverview({
      ...interval(),
      bucket: 'hour',
      createdOnPlatform: 'vscode',
    });
    const legacyRawPlatformHealth = await caller.admin.cloudAgentNext.getHealthOverview({
      ...interval(),
      bucket: 'hour',
      createdOnPlatform: ' code-review ',
    });
    await db
      .update(cli_sessions_v2)
      .set({ created_on_platform: 'unknown' })
      .where(eq(cli_sessions_v2.cloud_agent_session_id, ids.setupFailedLater));
    const platformsAfterStoredUnknown = await caller.admin.cloudAgentNext.listHealthPlatforms();
    const unknownHealth = await caller.admin.cloudAgentNext.getHealthOverview({
      ...interval(),
      bucket: 'hour',
      createdOnPlatform: null,
    });
    const vscodeRunSessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      source: 'run',
      stage: 'pre_dispatch',
      code: 'workspace_setup_failed',
      createdOnPlatform: 'vscode',
    });
    const unknownSetupSessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      source: 'setup',
      stage: 'initial_admission',
      code: 'initial_admission_rejected',
      createdOnPlatform: null,
    });

    expect(platforms).toEqual([' code-review ', 'vscode']);
    expect(platformsAfterStoredUnknown).toEqual(['vscode']);
    expect(vscodeHealth.summary).toEqual({
      completedRuns: 1,
      failedRuns: 1,
      interruptedRuns: 0,
      setupFailures: 0,
    });
    expect(vscodeHealth.topErrors).toEqual([
      { source: 'run', stage: 'pre_dispatch', code: 'workspace_setup_failed', count: 1 },
    ]);
    expect(legacyRawPlatformHealth.summary).toEqual({
      completedRuns: 0,
      failedRuns: 0,
      interruptedRuns: 0,
      setupFailures: 1,
    });
    expect(unknownHealth.summary).toEqual({
      completedRuns: 0,
      failedRuns: 1,
      interruptedRuns: 1,
      setupFailures: 2,
    });
    expect(vscodeRunSessions.rows).toEqual([
      expect.objectContaining({ cloudAgentSessionId: ids.mapped }),
    ]);
    expect(unknownSetupSessions).toMatchObject({ totalSessions: 2 });
    expect(unknownSetupSessions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cloudAgentSessionId: ids.setupFailed }),
        expect.objectContaining({ cloudAgentSessionId: ids.setupFailedLater }),
      ])
    );
  });

  it('summarizes longer health ranges into daily UTC buckets', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview({
      startDate: '2035-01-10T00:00:00.000Z',
      endDate: '2035-01-12T00:00:00.000Z',
      bucket: 'day',
    });

    expect(health.series).toEqual([
      {
        bucketStart: '2035-01-10T00:00:00.000Z',
        completedRuns: 1,
        failedRuns: 2,
        interruptedRuns: 1,
        setupFailures: 2,
      },
      {
        bucketStart: '2035-01-11T00:00:00.000Z',
        completedRuns: 0,
        failedRuns: 0,
        interruptedRuns: 0,
        setupFailures: 0,
      },
    ]);
  });

  it('summarizes rolling health intervals across partial daily UTC buckets', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview({
      startDate: '2035-01-09T12:00:00.000Z',
      endDate: at(5, 30),
      bucket: 'day',
    });

    expect(health.series).toEqual([
      {
        bucketStart: '2035-01-09T00:00:00.000Z',
        completedRuns: 0,
        failedRuns: 0,
        interruptedRuns: 0,
        setupFailures: 0,
      },
      {
        bucketStart: START_DATE,
        completedRuns: 1,
        failedRuns: 2,
        interruptedRuns: 1,
        setupFailures: 2,
      },
    ]);
  });

  it('summarizes rolling health intervals across partial hourly UTC buckets', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const health = await caller.admin.cloudAgentNext.getHealthOverview({
      startDate: at(0, 30),
      endDate: at(5, 30),
      bucket: 'hour',
    });

    expect(health.summary).toEqual({
      completedRuns: 1,
      failedRuns: 2,
      interruptedRuns: 1,
      setupFailures: 1,
    });
    expect(health.series).toEqual([
      {
        bucketStart: at(0),
        completedRuns: 0,
        failedRuns: 0,
        interruptedRuns: 0,
        setupFailures: 0,
      },
      {
        bucketStart: at(1),
        completedRuns: 1,
        failedRuns: 0,
        interruptedRuns: 0,
        setupFailures: 0,
      },
      {
        bucketStart: at(2),
        completedRuns: 0,
        failedRuns: 1,
        interruptedRuns: 0,
        setupFailures: 0,
      },
      {
        bucketStart: at(3),
        completedRuns: 0,
        failedRuns: 1,
        interruptedRuns: 0,
        setupFailures: 0,
      },
      {
        bucketStart: at(4),
        completedRuns: 0,
        failedRuns: 0,
        interruptedRuns: 1,
        setupFailures: 0,
      },
      {
        bucketStart: at(5),
        completedRuns: 0,
        failedRuns: 0,
        interruptedRuns: 0,
        setupFailures: 1,
      },
    ]);
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
    ]);
    const caller = await createCallerForUser(adminUser.id);
    const setupSessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      source: 'setup',
      stage: 'initial_admission',
      code: 'initial_admission_rejected',
    });
    const runSessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      source: 'run',
      stage: 'pre_dispatch',
      code: 'workspace_setup_failed',
    });
    const unclassifiedSessions = await caller.admin.cloudAgentNext.listHealthErrorSessions({
      ...interval(),
      source: 'run',
      stage: 'unknown',
      code: 'unclassified',
    });

    expect(setupSessions.totalSessions).toBe(2);
    expect(setupSessions.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cloudAgentSessionId: ids.setupFailed,
          kiloSessionId: 'ses_admin_setup_failed',
          occurredAt: at(0, 6),
          matchingEvents: 1,
        }),
        expect.objectContaining({
          cloudAgentSessionId: ids.setupFailedLater,
          kiloSessionId: 'ses_admin_setup_failed_later',
          matchingEvents: 1,
        }),
      ])
    );
    expect(runSessions).toMatchObject({
      totalSessions: 1,
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
  });
});
