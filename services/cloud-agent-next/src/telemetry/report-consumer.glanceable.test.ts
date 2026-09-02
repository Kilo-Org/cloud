import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, getTableColumns, getTableName, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pg-proxy';
import type { WorkerDb } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  cloud_agent_session_runs,
  cloud_agent_sessions,
  github_branch_pull_requests,
} from '@kilocode/db/schema';
import type { RefreshGlanceableSessionsParams } from '@kilocode/notifications';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '../../../../packages/app-shared/src/glanceable-agents-snapshot';
import { deliverGlanceableSnapshot } from '../../../notifications/src/lib/glanceable-delivery';
import type { ExpoPushMessage } from '../../../notifications/src/lib/expo-push';

const database = vi.hoisted(() => ({ current: undefined as WorkerDb | undefined }));
vi.mock('../db/pg.js', () => ({ getPgDb: () => database.current }));
vi.mock('../../../../apps/web/node_modules/server-only/index.js', () => ({}));
vi.mock('@/lib/config.server', () => ({ SESSION_INGEST_WORKER_URL: undefined }));
vi.mock('@/lib/tokens', () => ({ generateInternalServiceToken: vi.fn() }));
vi.mock('@/lib/drizzle', () => ({
  get db() {
    return database.current;
  },
}));
vi.mock('@/routers/cli-sessions-v2-router', async () => {
  const { sql } = await import('drizzle-orm');
  const { z } = await import('zod');
  return {
    associatedPrSchema: z.unknown(),
    formatAssociatedPr: () => null,
    sessionPrJoinPredicate: sql`false`,
  };
});

import { consumeCloudAgentReportBatch } from './report-consumer.js';

// Load the real web query without adding the web app's alias graph to the service typecheck.
const { listActiveSessions } = await vi.importActual<{
  listActiveSessions: (input: {
    userId: string;
    organizationId: string | null;
    includeCloudAgentSessions: boolean;
  }) => Promise<{ sessions: { id: string; status: string }[] }>;
}>('../../../../apps/web/src/lib/active-sessions-list');

const cloudAgentSessionId = 'agent_12345678-1234-4234-8234-123456789abc';
const cliSessionId = 'ses_12345678901234567890123456';
const userId = 'oauth/cloud-eligibility';
const occurredAt = '2026-08-28T10:00:00.000Z';
const report: CloudAgentQueueReport = {
  version: 1,
  type: 'run.state',
  occurredAt,
  session: { cloudAgentSessionId },
  run: { messageId: 'msg_1', status: 'accepted', dispatchAcceptedAt: occurredAt },
};

function messageFor(body: unknown) {
  return {
    body,
    outcome: 'pending',
    ack() {
      this.outcome = 'ack';
    },
    retry() {
      this.outcome = 'retry';
    },
  };
}

function setup(options: { beforeCommit?: () => Promise<void>; refreshError?: Error } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const table of [
    cli_sessions_v2,
    cloud_agent_sessions,
    cloud_agent_session_runs,
    github_branch_pull_requests,
  ]) {
    const columns = Object.values(getTableColumns(table)).map(column => `"${column.name}"`);
    sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${columns.join(', ')})`);
  }

  // Run the real Drizzle queries, including the web list's EXISTS/root/scope predicates.
  // SQLite needs positional placeholders, explicit null defaults, and a test-clock idle cutoff.
  const db = drizzle(async (query, params) => {
    if (query.includes('pg_advisory_xact_lock')) return { rows: [] };
    const statement = sqlite.prepare(
      query
        .replace(/\$\d+/g, '?')
        .replace(/\bdefault\b/gi, 'null')
        .replace(
          "now() - interval '15 minutes'",
          `'${new Date(Date.now() - 15 * 60_000).toISOString()}'`
        )
    );
    statement.setReturnArrays(true);
    return { rows: statement.all(...params) };
  });
  db.transaction = async operation => {
    sqlite.exec('BEGIN');
    try {
      const result = await operation(db as never);
      await options.beforeCommit?.();
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  };
  database.current = db as unknown as WorkerDb;

  const messages: ExpoPushMessage[] = [];
  const previous = new Map<string | null, GlanceableAgentsSnapshot>();
  const env = {
    NOTIFICATIONS: {
      // The aggregate path must not use the attention transport or its preference/presence gates.
      sendCloudAgentSessionNotification() {
        throw new Error('Attention notifications are disabled and the session has a viewer');
      },
      async refreshGlanceableSessions(params: RefreshGlanceableSessionsParams) {
        if (options.refreshError) throw options.refreshError;
        expect(Object.keys(params).sort()).toEqual(['cliSessionIds', 'userId']);
        const rows = await db
          .select({ organizationId: cli_sessions_v2.organization_id })
          .from(cli_sessions_v2)
          .where(
            and(
              eq(cli_sessions_v2.kilo_user_id, params.userId),
              inArray(cli_sessions_v2.session_id, params.cliSessionIds)
            )
          );
        for (const organizationId of new Set(rows.map(row => row.organizationId))) {
          await deliverGlanceableSnapshot(
            { userId: params.userId, organizationId },
            {
              buildSnapshot: async (owner, organizationId) => {
                const { sessions } = await listActiveSessions({
                  userId: owner,
                  organizationId,
                  includeCloudAgentSessions: true,
                });
                const prior = previous.get(organizationId);
                const snapshot = buildGlanceableSnapshot({
                  userId: owner,
                  organizationId,
                  sessions,
                  now: Date.now(),
                  previousRevision: prior?.revision,
                  previousEligibleStartedAt: prior?.eligibleStartedAt,
                });
                previous.set(organizationId, snapshot);
                return { type: 'active_agents_glanceable', ...snapshot };
              },
              listIosActivityTokens: async () => [],
              sendIosLiveActivity: async () => undefined,
              listIosExpoTokens: async () => [{ token: 'ExponentPushToken[test]', locale: null }],
              hasAndroidOngoingToken: async () => false,
              listAndroidExpoTokens: async () => [],
              sendExpoPush: async incoming => {
                messages.push(...incoming);
              },
            }
          );
        }
      },
    },
  };
  async function seed(status = 'busy', organizationId: string | null = null) {
    await db.insert(cloud_agent_sessions).values({
      cloud_agent_session_id: cloudAgentSessionId,
      kilo_session_id: cliSessionId,
      initial_message_id: report.run.messageId,
      created_at: occurredAt,
    });
    await db.insert(cli_sessions_v2).values({
      session_id: cliSessionId,
      kilo_user_id: userId,
      cloud_agent_session_id: cloudAgentSessionId,
      status,
      organization_id: organizationId,
      created_at: occurredAt,
      updated_at: occurredAt,
      status_updated_at: occurredAt,
    });
  }
  async function consume(body: unknown = report) {
    const message = messageFor(body);
    await consumeCloudAgentReportBatch({ messages: [message] } as never, env as never);
    return message.outcome;
  }
  return { db, sqlite, env, seed, consume, messages };
}

let fixture: ReturnType<typeof setup>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(occurredAt));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  fixture?.sqlite.close();
  database.current = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function activeIds(organizationId: string | null = null) {
  const { sessions } = await listActiveSessions({
    userId,
    organizationId,
    includeCloudAgentSessions: true,
  });
  return sessions.map(session => session.id).sort();
}

describe('committed cloud eligibility refresh', () => {
  it.each([null, '11111111-1111-4111-8111-111111111111'])(
    'refreshes delayed run insertion in scope %s without attention delivery',
    async organizationId => {
      fixture = setup();
      await fixture.seed('busy', organizationId);
      expect(await activeIds(organizationId)).toEqual([]);

      expect(await fixture.consume()).toBe('ack');

      expect(await activeIds(organizationId)).toEqual([cliSessionId]);
      expect(fixture.messages.map(message => message.data)).toMatchObject([
        {
          status: 'happy',
          running: 1,
          idle: 0,
          organizationBound: organizationId !== null,
        },
      ]);
    }
  );

  it.each(['busy', 'retry'])(
    'removes a terminal run while the stored session remains %s',
    async status => {
      fixture = setup();
      await fixture.seed(status);
      await fixture.consume();
      const terminalAt = '2026-08-28T10:04:00.000Z';
      expect(
        await fixture.consume({
          ...report,
          run: {
            messageId: report.run.messageId,
            status: 'failed',
            terminalAt,
            failureStage: 'unknown',
            failureCode: 'unclassified',
          },
        })
      ).toBe('ack');

      expect(await activeIds()).toEqual([]);
      expect(
        await fixture.db.select({ status: cli_sessions_v2.status }).from(cli_sessions_v2)
      ).toEqual([{ status }]);
      expect(fixture.messages.map(message => message.data)).toMatchObject([
        {
          status: 'happy',
          running: status === 'busy' ? 1 : 0,
          needsInput: status === 'retry' ? 1 : 0,
        },
        { status: 'empty', running: 0, needsInput: 0, idle: 0, eligibleStartedAt: null },
      ]);
    }
  );

  it('retains the eligible interval when nonterminal retry work refreshes', async () => {
    fixture = setup();
    await fixture.seed();
    await fixture.consume();
    vi.setSystemTime(new Date('2026-08-28T10:02:00.000Z'));
    await fixture.db
      .update(cli_sessions_v2)
      .set({ status: 'retry', updated_at: new Date().toISOString() })
      .where(eq(cli_sessions_v2.session_id, cliSessionId));
    await fixture.consume();
    expect(fixture.messages.map(message => message.data)).toMatchObject([
      { running: 1, eligibleStartedAt: occurredAt },
      { running: 0, needsInput: 1, eligibleStartedAt: occurredAt },
    ]);
  });

  it('does not refresh before the report transaction commits', async () => {
    const started = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    fixture = setup({
      beforeCommit: async () => {
        started.resolve();
        await commit.promise;
      },
    });
    await fixture.seed();
    const consuming = fixture.consume();
    await started.promise;
    expect(fixture.messages).toEqual([]);
    commit.resolve();
    expect(await consuming).toBe('ack');
    expect(fixture.messages.map(message => message.data)).toMatchObject([{ running: 1 }]);
  });

  it('retries a failed commit without publishing uncommitted work', async () => {
    fixture = setup({
      beforeCommit: async () => {
        throw new Error('commit failed');
      },
    });
    await fixture.seed();
    expect(await fixture.consume()).toBe('retry');
    expect(await fixture.db.select().from(cloud_agent_session_runs)).toEqual([]);
    expect(fixture.messages).toEqual([]);
  });

  it('keeps a committed report acknowledged when refresh fails without logging credentials', async () => {
    fixture = setup({
      refreshError: new Error('upstream-error-body-must-not-be-logged'),
    });
    await fixture.seed();
    expect(await fixture.consume()).toBe('ack');
    expect(await activeIds()).toEqual([cliSessionId]);
    expect(fixture.messages).toEqual([]);
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['Cloud Agent glanceable refresh failed', { cloudAgentSessionId }],
    ]);
    expect(vi.mocked(console.error).mock.calls).toEqual([]);
  });

  it('acknowledges duplicate and out-of-order reports without reviving terminal work', async () => {
    fixture = setup();
    await fixture.seed();
    const completed = {
      ...report,
      run: { messageId: report.run.messageId, status: 'completed', terminalAt: occurredAt },
    };
    const outcomes = [];
    for (const body of [report, report, completed, completed, report]) {
      outcomes.push(await fixture.consume(body));
    }
    expect(outcomes).toEqual(['ack', 'ack', 'ack', 'ack', 'ack']);
    expect(
      await fixture.db
        .select({
          status: cloud_agent_session_runs.status,
          terminalAt: cloud_agent_session_runs.terminal_at,
        })
        .from(cloud_agent_session_runs)
    ).toEqual([{ status: 'completed', terminalAt: occurredAt }]);
    expect(fixture.messages.map(message => message.data)).toMatchObject([
      { running: 1 },
      { running: 1 },
      { running: 0 },
      { running: 0 },
      { running: 0 },
    ]);
  });

  it('keeps the session counted until its last nonterminal run ends', async () => {
    fixture = setup();
    await fixture.seed();
    for (const run of [
      report.run,
      { messageId: 'msg_2', status: 'queued', queuedAt: occurredAt },
      { messageId: report.run.messageId, status: 'completed', terminalAt: occurredAt },
      { messageId: 'msg_2', status: 'interrupted', terminalAt: occurredAt },
    ]) {
      expect(await fixture.consume({ ...report, run })).toBe('ack');
    }
    expect(fixture.messages.map(message => message.data)).toMatchObject([
      { running: 1 },
      { running: 1 },
      { running: 1 },
      { status: 'empty', running: 0 },
    ]);
    expect(await activeIds()).toEqual([]);
  });

  // An expired anchor is final, so its report is acknowledged. A missing anchor
  // is retried: the session row can still arrive.
  it.each([
    ['expired', 'ack'],
    ['missing_parent', 'retry'],
  ] as const)('does not publish an unapplied %s report', async (outcome, expected) => {
    fixture = setup();
    await fixture.seed();
    const parent = eq(cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId);
    if (outcome === 'expired') {
      await fixture.db
        .update(cloud_agent_sessions)
        .set({ created_at: '2026-05-01T00:00:00.000Z' })
        .where(parent);
    } else {
      await fixture.db.delete(cloud_agent_sessions).where(parent);
    }
    expect(await fixture.consume()).toBe(expected);
    expect(await fixture.db.select().from(cloud_agent_session_runs)).toEqual([]);
    expect(fixture.messages).toEqual([]);
  });

  it('does not invent a recipient when CLI session metadata has not arrived', async () => {
    fixture = setup();
    await fixture.seed();
    await fixture.db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, cliSessionId));
    expect(await fixture.consume()).toBe('ack');
    expect(
      await fixture.db
        .select({ status: cloud_agent_session_runs.status })
        .from(cloud_agent_session_runs)
    ).toEqual([{ status: 'accepted' }]);
    expect(fixture.messages).toEqual([]);
  });

  it('uses the real cloud predicate for roots, run liveness, warm idle, and scope', async () => {
    fixture = setup();
    await fixture.seed();
    for (const [id, status, parent, owner, organization, cloudId, updated] of [
      ['no-run', 'retry', null, userId, null, 'no-run-cloud', occurredAt],
      ['terminal', 'busy', null, userId, null, 'terminal-cloud', occurredAt],
      ['warm-idle', 'idle', null, userId, null, 'terminal-cloud', occurredAt],
      ['cold-idle', 'idle', null, userId, null, 'terminal-cloud', '2026-08-28T09:40:00.000Z'],
      ['child', 'busy', cliSessionId, userId, null, cloudAgentSessionId, occurredAt],
      ['other-user', 'busy', null, 'oauth/other', null, cloudAgentSessionId, occurredAt],
      ['other-org', 'busy', null, userId, 'another-org', cloudAgentSessionId, occurredAt],
      ['not-cloud', 'busy', null, userId, null, null, occurredAt],
    ]) {
      await fixture.db.insert(cli_sessions_v2).values({
        session_id: id!,
        status,
        parent_session_id: parent,
        kilo_user_id: owner!,
        organization_id: organization,
        cloud_agent_session_id: cloudId,
        status_updated_at: updated,
        created_at: occurredAt,
        updated_at: occurredAt,
      });
    }
    await fixture.db.insert(cloud_agent_session_runs).values({
      cloud_agent_session_id: 'terminal-cloud',
      message_id: 'terminal-msg',
      status: 'completed',
      terminal_at: occurredAt,
    });
    expect(await activeIds()).toEqual(['warm-idle']);
    await fixture.consume();
    expect(await activeIds()).toEqual([cliSessionId, 'warm-idle']);
    expect(
      fixture.messages
        .filter(
          message =>
            message.data?.type === 'active_agents_glanceable' && !message.data.organizationBound
        )
        .map(message => message.data)
      // The busy CLI row counts as running and the warm-idle cloud row as idle:
      // the counts read `status` alone, so cloud and CLI sessions merge.
    ).toMatchObject([{ running: 1, needsInput: 0, idle: 1 }]);
  });
});
