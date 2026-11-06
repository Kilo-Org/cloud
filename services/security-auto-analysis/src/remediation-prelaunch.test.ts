import { createHash } from 'crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { settleOperation } from '@kilocode/db/operation-ledger';
import {
  agent_configs,
  kilocode_users,
  operation_ledgers,
  platform_integrations,
  security_remediation_attempts,
  security_remediations,
} from '@kilocode/db/schema';
import type * as SecurityFindingAuditModule from '@kilocode/worker-utils/security-finding-audit';
import { insertSecurityFindingAuditEvent } from '@kilocode/worker-utils/security-finding-audit';
import type * as QueriesModule from './db/queries.js';
import { getAnalysisActorById, getSecurityFindingById } from './db/queries.js';
import {
  finalizeRemediationCallbackFromEnv,
  processRemediationAttempt,
  recoverStaleRemediationLaunchAttempts,
} from './remediation.js';
import { DEFAULT_SECURITY_AGENT_CONFIG } from './types.js';

vi.mock('@kilocode/db/operation-ledger', () => ({
  admitOperation: vi.fn(),
  recordOperationAcceptance: vi.fn(),
  settleOperation: vi.fn(),
}));

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));

vi.mock('./db/queries.js', async importOriginal => ({
  ...(await importOriginal<typeof QueriesModule>()),
  getSecurityFindingById: vi.fn(),
  getAnalysisActorById: vi.fn(),
  resolveAutoAnalysisActor: vi.fn(),
}));

vi.mock('@kilocode/worker-utils/security-finding-audit', async importOriginal => ({
  ...(await importOriginal<typeof SecurityFindingAuditModule>()),
  insertSecurityFindingAuditEvent: vi.fn(),
}));

const ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REMEDIATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND_ATTEMPT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SECOND_FINDING_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SECOND_REMEDIATION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const NOW = '2026-01-02T00:00:00.000Z';
const OLD = '2026-01-01T00:00:00.000Z';
const CUTOFF = new Date('2026-01-01T00:30:00.000Z');

const dialect = new PgDialect();

type Row = Record<string, unknown>;

type RecordedUpdate = {
  table: unknown;
  values: Row;
  condition: SQL | undefined;
};

const ATTEMPT_COLUMNS = [
  'id',
  'status',
  'claim_token',
  'claimed_at',
  'cloud_agent_session_id',
  'kilo_session_id',
  'execution_id',
  'launched_at',
  'callback_attempt_token_hash',
  'cancellation_requested_at',
] as const;

const REMEDIATION_COLUMNS = ['id'] as const;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rowMatchesCondition(
  row: Row,
  condition: SQL | undefined,
  columns: readonly string[]
): boolean {
  if (!condition) return true;
  const { sql, params } = dialect.sqlToQuery(condition);

  for (const column of columns) {
    const quoted = `"${column}"`;
    if (sql.includes(`${quoted} is null`) && row[column] !== null) return false;
    if (sql.includes(`${quoted} is not null`) && row[column] === null) return false;

    const eq = sql.match(new RegExp(`${escapeRegExp(quoted)} = \\$(\\d+)`));
    if (eq && row[column] !== params[Number(eq[1]) - 1]) return false;

    const inList = sql.match(new RegExp(`${escapeRegExp(quoted)} in \\(([^)]+)\\)`));
    if (inList) {
      const allowed = inList[1].split(',').map(part => params[Number(part.trim().slice(1)) - 1]);
      if (!allowed.includes(row[column])) return false;
    }

    const lte = sql.match(new RegExp(`${escapeRegExp(quoted)} <= \\$(\\d+)`));
    if (lte) {
      const boundary = Date.parse(String(params[Number(lte[1]) - 1]));
      const value = Date.parse(String(row[column]));
      if (!Number.isFinite(value) || !Number.isFinite(boundary) || value > boundary) return false;
    }
  }

  return true;
}

function selectResult(rows: Row[], sortByClaim: boolean) {
  const ordered = sortByClaim
    ? [...rows].sort(
        (a, b) =>
          String(a.claimed_at).localeCompare(String(b.claimed_at)) ||
          String(a.id).localeCompare(String(b.id))
      )
    : rows;
  return {
    then: (resolve: (value: Row[]) => void) => resolve(ordered),
    limit: async () => ordered,
    orderBy: () => selectResult(ordered, false),
    innerJoin: () => selectResult(ordered, false),
  };
}

function eligibleFinding(id = FINDING_ID): Row {
  return {
    id,
    platform_integration_id: 'integration-1',
    owned_by_user_id: 'user-1',
    owned_by_organization_id: null,
    repo_full_name: 'example/repo',
    source: 'dependabot',
    source_id: '1',
    status: 'open',
    severity: 'high',
    package_name: 'example-package',
    package_ecosystem: 'npm',
    dependency_scope: 'runtime',
    cve_id: null,
    ghsa_id: null,
    cwe_ids: null,
    cvss_score: null,
    title: 'Test finding',
    description: null,
    vulnerable_version_range: null,
    patched_version: null,
    manifest_path: 'package.json',
    raw_data: { updated_at: OLD },
    last_synced_at: NOW,
    analysis_status: 'completed',
    analysis_completed_at: NOW,
    analysis: {
      analyzedAt: NOW,
      sandboxAnalysis: {
        isExploitable: true,
        suggestedAction: 'open_pr',
        suggestedFix: 'Upgrade the dependency',
        usageLocations: [],
        summary: 'Reachable vulnerable dependency',
        rawMarkdown: '',
        analysisAt: NOW,
      },
    },
  };
}

function launchAttemptRow(overrides: Row = {}): Row {
  return {
    id: ATTEMPT_ID,
    finding_id: FINDING_ID,
    remediation_id: REMEDIATION_ID,
    owned_by_organization_id: null,
    owned_by_user_id: 'user-1',
    repo_full_name: 'example/repo',
    origin: 'manual',
    status: 'queued',
    attempt_number: 1,
    requested_by_user_id: 'user-1',
    analysis_fingerprint: 'fingerprint',
    remediation_model_slug: 'model',
    branch_name: 'security-remediation/example',
    cloud_agent_session_id: null,
    kilo_session_id: null,
    execution_id: null,
    claim_token: null,
    claimed_at: null,
    claimed_by_job_id: null,
    launch_attempt_count: 0,
    next_retry_at: null,
    callback_attempt_token_hash: null,
    launched_at: null,
    cancellation_requested_at: null,
    queued_at: OLD,
    completed_at: null,
    failure_code: null,
    blocked_reason: null,
    last_error_redacted: null,
    priority: 50,
    updated_at: OLD,
    ...overrides,
  };
}

function runtimeConfig() {
  return {
    ...DEFAULT_SECURITY_AGENT_CONFIG,
    auto_remediation_enabled: true,
    auto_remediation_require_approval: false,
    auto_remediation_enabled_at: OLD,
    repository_selection_mode: 'all',
  };
}

function applyValues(row: Row, values: Row) {
  for (const [key, value] of Object.entries(values)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      row[key] = value;
    } else if (key.endsWith('_at')) {
      row[key] = NOW;
    }
  }
}

function createRecordingDb(options: {
  attempts: Row[];
  remediations: Row[];
  ledgerRow?: Row;
  userRow?: Row;
  cancellationRequestedAt?: string | null;
  afterClaim?: (attempt: Row) => void;
  afterSelect?: (rows: Row[]) => void;
  beforeAttemptUpdate?: (rows: Row[]) => void;
}) {
  const updates: RecordedUpdate[] = [];
  const selects: { condition: SQL | undefined; projection: Row | undefined }[] = [];

  const rowsFor = (table: unknown): Row[] => {
    if (table === security_remediation_attempts) return options.attempts;
    if (table === security_remediations) return options.remediations;
    if (table === agent_configs) return [{ config: runtimeConfig(), is_enabled: true }];
    if (table === platform_integrations)
      return [{ repositories: [{ id: 1, full_name: 'example/repo' }] }];
    if (table === operation_ledgers) return options.ledgerRow ? [options.ledgerRow] : [];
    if (table === kilocode_users) return options.userRow ? [options.userRow] : [];
    return [];
  };

  const update = (table: unknown) => ({
    set: (values: Row) => ({
      where: (condition: SQL | undefined) => {
        updates.push({ table, values, condition });
        if (table === security_remediation_attempts)
          options.beforeAttemptUpdate?.(options.attempts);
        const candidates = rowsFor(table);
        const columns =
          table === security_remediation_attempts ? ATTEMPT_COLUMNS : REMEDIATION_COLUMNS;
        const target = candidates.find(row => rowMatchesCondition(row, condition, columns));
        if (target) applyValues(target, values);
        return {
          then: (resolve: (value: Row[]) => void) => resolve(target ? [target] : []),
          returning: async () => (target ? [target] : []),
        };
      },
    }),
  });

  const db = {
    execute: vi.fn(async () => {
      const attempt = options.attempts.find(row => row.status === 'queued');
      if (!attempt) return { rows: [] };
      attempt.status = 'launching';
      attempt.claim_token = 'claim-token-1';
      attempt.claimed_at = NOW;
      attempt.claimed_by_job_id = 'job-1';
      attempt.launch_attempt_count = Number(attempt.launch_attempt_count ?? 0) + 1;
      attempt.updated_at = NOW;
      const claimed = { ...attempt };
      options.afterClaim?.(attempt);
      return { rows: [claimed] };
    }),
    select: vi.fn((projection?: Row) => ({
      from: (table: unknown) => ({
        where: (condition: SQL | undefined) => {
          selects.push({ condition, projection });
          if (
            table === security_remediation_attempts &&
            projection !== undefined &&
            'cancellationRequestedAt' in projection
          ) {
            return selectResult(
              [{ cancellationRequestedAt: options.cancellationRequestedAt ?? null }],
              false
            );
          }
          const rows =
            table === security_remediation_attempts
              ? options.attempts.filter(row => rowMatchesCondition(row, condition, ATTEMPT_COLUMNS))
              : rowsFor(table);
          if (table === security_remediation_attempts) options.afterSelect?.(rows);
          return selectResult(rows, table === security_remediation_attempts);
        },
      }),
    })),
    update,
    transaction: vi.fn(async (callback: (tx: { update: typeof update }) => Promise<unknown>) => {
      const snapshot = {
        attempts: structuredClone(options.attempts),
        remediations: structuredClone(options.remediations),
      };
      try {
        return await callback({ update });
      } catch (error) {
        options.attempts.splice(0, options.attempts.length, ...snapshot.attempts);
        options.remediations.splice(0, options.remediations.length, ...snapshot.remediations);
        throw error;
      }
    }),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
  };

  return {
    db,
    updates,
    selects,
    attempt: (id = ATTEMPT_ID) => options.attempts.find(row => row.id === id),
    remediation: (id = REMEDIATION_ID) => options.remediations.find(row => row.id === id),
  };
}

function processEnv(cloudFetch: ReturnType<typeof vi.fn>) {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' },
    ENVIRONMENT: 'development',
    SHARED_RESOURCE_TOKENS_ENABLED: false,
    KILOCODE_BACKEND_BASE_URL: 'https://app.example',
    NEXTAUTH_SECRET: { get: async () => 'next-auth-secret' },
    INTERNAL_API_SECRET: { get: async () => 'internal-api-secret' },
    CALLBACK_TOKEN_SECRET: { get: async () => 'callback-token-secret' },
    SECURITY_ANALYSIS_CALLBACK_ROUTING_MODE: 'web',
    SECURITY_ANALYSIS_CALLBACK_WEB_BASE_URL: 'https://app.example',
    CLOUD_AGENT_NEXT: { fetch: cloudFetch },
  } as unknown as CloudflareEnv;
}

function prepareResponse() {
  return Response.json({
    result: { data: { cloudAgentSessionId: 'prepared-session', kiloSessionId: 'kilo-session' } },
  });
}

function cloudAgentFetch(options: { initiateStatus?: number } = {}) {
  return vi.fn(async (request: Request) => {
    if (request.url.endsWith('/prepareSession')) return prepareResponse();
    if (request.url.endsWith('/initiateFromKilocodeSessionV2')) {
      if (options.initiateStatus !== undefined) {
        return new Response('initiate failed', { status: options.initiateStatus });
      }
      return Response.json({
        result: { data: { executionId: 'execution-1', status: 'running' } },
      });
    }
    throw new Error(`unexpected Cloud Agent request: ${request.url}`);
  });
}

function compiled(condition: SQL | undefined) {
  if (!condition) throw new Error('Expected a SQL condition');
  return dialect.sqlToQuery(condition);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAnalysisActorById).mockResolvedValue({
    id: 'user-1',
    email: 'owner@example.com',
    name: 'Owner',
    api_token_pepper: null,
  } as never);
  vi.mocked(insertSecurityFindingAuditEvent).mockResolvedValue({
    inserted: true,
    id: 'audit-1',
  });
  vi.mocked(settleOperation).mockResolvedValue({ settled: true } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remediation prelaunch claim recovery', () => {
  it('requeues the matching launching claim when a postclaim read throws', async () => {
    const state = createRecordingDb({
      attempts: [launchAttemptRow()],
      remediations: [{ id: REMEDIATION_ID, status: 'queued' }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);
    vi.mocked(getSecurityFindingById).mockRejectedValue(new Error('finding read failed'));
    const cloudFetch = cloudAgentFetch();

    await expect(
      processRemediationAttempt({
        env: processEnv(cloudFetch),
        attemptId: ATTEMPT_ID,
        dispatchId: 'dispatch-1',
      })
    ).resolves.toBe('failed');

    const failureUpdate = state.updates.find(
      update => update.values.failure_code === 'PRELAUNCH_READ_FAILED'
    );
    const query = compiled(failureUpdate?.condition);
    expect(query.sql).toContain('"security_remediation_attempts"."claim_token" =');
    expect(query.sql).toContain('"security_remediation_attempts"."status" in');

    expect(state.attempt()).toMatchObject({
      status: 'queued',
      claim_token: null,
      claimed_at: null,
      claimed_by_job_id: null,
      failure_code: 'PRELAUNCH_READ_FAILED',
      launch_attempt_count: 1,
    });
    expect(state.attempt()?.next_retry_at).toEqual(expect.any(String));
    expect(state.remediation()).toMatchObject({ status: 'queued' });
    expect(cloudFetch).not.toHaveBeenCalled();
  });

  it('recovers stale launching claims including retry rows and excludes running rows', async () => {
    const stale = launchAttemptRow({
      status: 'launching',
      claim_token: 'stale-claim',
      claimed_at: OLD,
      launch_attempt_count: 1,
    });
    const fresh = launchAttemptRow({
      id: SECOND_ATTEMPT_ID,
      finding_id: SECOND_FINDING_ID,
      remediation_id: SECOND_REMEDIATION_ID,
      status: 'launching',
      claim_token: 'fresh-claim',
      claimed_at: NOW,
      launch_attempt_count: 1,
    });
    const running = launchAttemptRow({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      status: 'running',
      claim_token: 'running-claim',
      claimed_at: OLD,
      launched_at: OLD,
      cloud_agent_session_id: 'running-session',
      kilo_session_id: 'running-kilo-session',
      callback_attempt_token_hash: hashToken('running-attempt'),
      launch_attempt_count: 1,
    });
    const runningWithoutMarkers = launchAttemptRow({
      id: '99999999-9999-4999-8999-999999999999',
      status: 'running',
      claim_token: 'running-unmarked-claim',
      claimed_at: OLD,
      launch_attempt_count: 1,
    });
    const markedLaunching = launchAttemptRow({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      finding_id: SECOND_FINDING_ID,
      remediation_id: SECOND_REMEDIATION_ID,
      status: 'launching',
      claim_token: 'marked-claim',
      claimed_at: OLD,
      cloud_agent_session_id: 'prepared-session',
      kilo_session_id: 'prepared-kilo-session',
      execution_id: 'retry-execution',
      launched_at: OLD,
      callback_attempt_token_hash: hashToken('retry-attempt'),
      launch_attempt_count: 1,
    });
    const state = createRecordingDb({
      attempts: [stale, fresh, running, runningWithoutMarkers, markedLaunching],
      remediations: [
        { id: REMEDIATION_ID, status: 'queued' },
        { id: SECOND_REMEDIATION_ID, status: 'queued' },
      ],
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);

    await expect(
      recoverStaleRemediationLaunchAttempts(state.db as never, {
        env: processEnv(cloudAgentFetch()),
        claimedBefore: CUTOFF,
      })
    ).resolves.toEqual({ requeuedCount: 2, failedCount: 0, cancelledCount: 0 });

    const select = state.selects.find(entry => entry.projection === undefined);
    const query = compiled(select?.condition);
    expect(query.sql).toContain('"security_remediation_attempts"."status" =');
    expect(query.sql).toContain('"security_remediation_attempts"."claim_token" is not null');
    expect(query.sql).toContain('"security_remediation_attempts"."claimed_at" is not null');
    expect(query.sql).toContain('"security_remediation_attempts"."claimed_at" <=');
    expect(query.sql).not.toContain(
      '"security_remediation_attempts"."cloud_agent_session_id" is null'
    );
    expect(query.sql).not.toContain('"security_remediation_attempts"."kilo_session_id" is null');
    expect(query.sql).not.toContain('"security_remediation_attempts"."execution_id" is null');
    expect(query.sql).not.toContain('"security_remediation_attempts"."launched_at" is null');
    expect(query.sql).not.toContain(
      '"security_remediation_attempts"."callback_attempt_token_hash" is null'
    );

    expect(stale).toMatchObject({ status: 'queued', claim_token: null });
    expect(markedLaunching).toMatchObject({ status: 'queued', claim_token: null });
    expect(fresh).toMatchObject({ status: 'launching', claim_token: 'fresh-claim' });
    expect(running).toMatchObject({ status: 'running', claim_token: 'running-claim' });
    expect(runningWithoutMarkers).toMatchObject({
      status: 'running',
      claim_token: 'running-unmarked-claim',
    });
  });

  it('does not requeue a live execution that wins running between select and recovery', async () => {
    const stale = launchAttemptRow({
      status: 'launching',
      claim_token: 'stale-claim',
      claimed_at: OLD,
      launch_attempt_count: 1,
    });
    const state = createRecordingDb({
      attempts: [stale],
      remediations: [{ id: REMEDIATION_ID, status: 'queued' }],
      afterSelect: rows => {
        const row = rows[0];
        if (!row) return;
        row.status = 'running';
        row.cloud_agent_session_id = 'live-session';
        row.kilo_session_id = 'live-kilo-session';
        row.launched_at = NOW;
      },
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);

    await expect(
      recoverStaleRemediationLaunchAttempts(state.db as never, {
        env: processEnv(cloudAgentFetch()),
        claimedBefore: CUTOFF,
      })
    ).resolves.toEqual({ requeuedCount: 0, failedCount: 0, cancelledCount: 0 });

    const transition = state.updates.find(
      update => update.values.failure_code === 'PRELAUNCH_TIMEOUT'
    );
    const query = compiled(transition?.condition);
    expect(query.sql).toContain('"security_remediation_attempts"."claim_token" =');
    expect(query.sql).toContain('"security_remediation_attempts"."status" =');
    expect(query.sql).toContain('"security_remediation_attempts"."claimed_at" <=');

    expect(state.attempt()).toMatchObject({
      status: 'running',
      claim_token: 'stale-claim',
      cloud_agent_session_id: 'live-session',
    });
    expect(state.remediation()).toMatchObject({ status: 'queued' });
    expect(insertSecurityFindingAuditEvent).not.toHaveBeenCalled();
    expect(settleOperation).not.toHaveBeenCalled();
  });

  it('does not fail an expired claim when cancellation arrives during recovery', async () => {
    const stale = launchAttemptRow({
      status: 'launching',
      claim_token: 'stale-claim',
      claimed_at: OLD,
      launch_attempt_count: 3,
    });
    const state = createRecordingDb({
      attempts: [stale],
      remediations: [{ id: REMEDIATION_ID, status: 'queued' }],
      beforeAttemptUpdate: rows => {
        if (rows[0]) rows[0].cancellation_requested_at = NOW;
      },
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleFinding() as never);

    await expect(
      recoverStaleRemediationLaunchAttempts(state.db as never, {
        env: processEnv(cloudAgentFetch()),
        claimedBefore: CUTOFF,
      })
    ).resolves.toEqual({ requeuedCount: 0, failedCount: 0, cancelledCount: 0 });

    expect(state.attempt()).toMatchObject({ status: 'launching', cancellation_requested_at: NOW });
    expect(state.remediation()).toMatchObject({ status: 'queued' });
    expect(insertSecurityFindingAuditEvent).not.toHaveBeenCalled();
    expect(settleOperation).not.toHaveBeenCalled();
  });

  it('does not initiate when the running handoff loses the claim race', async () => {
    const state = createRecordingDb({
      attempts: [launchAttemptRow()],
      remediations: [{ id: REMEDIATION_ID, status: 'queued' }],
      afterClaim: attempt => {
        attempt.claim_token = 'successor-claim';
      },
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleFinding() as never);
    const cloudFetch = cloudAgentFetch();

    await expect(
      processRemediationAttempt({
        env: processEnv(cloudFetch),
        attemptId: ATTEMPT_ID,
        dispatchId: 'dispatch-1',
      })
    ).resolves.toBe('skipped');

    const handoff = state.updates.find(update => update.values.status === 'running');
    const query = compiled(handoff?.condition);
    expect(query.sql).toContain('"security_remediation_attempts"."claim_token" =');
    expect(query.sql).toContain('"security_remediation_attempts"."status" =');
    expect(query.sql).not.toContain('"cloud_agent_session_id" is null');
    expect(query.sql).not.toContain('"kilo_session_id" is null');
    expect(query.sql).not.toContain('"execution_id" is null');
    expect(query.sql).not.toContain('"launched_at" is null');
    expect(query.sql).not.toContain('"callback_attempt_token_hash" is null');

    expect(cloudFetch).toHaveBeenCalledTimes(1);
    expect(String(cloudFetch.mock.calls[0]?.[0]?.url)).toContain('/prepareSession');
    expect(state.attempt()).toMatchObject({ status: 'launching', claim_token: 'successor-claim' });
    expect(state.remediation()).toMatchObject({ status: 'queued' });
  });

  it('keeps retry handoff working when prior launch markers remain', async () => {
    const state = createRecordingDb({
      attempts: [
        launchAttemptRow({
          cloud_agent_session_id: 'old-session',
          kilo_session_id: 'old-kilo-session',
          launched_at: OLD,
          execution_id: 'old-execution',
          callback_attempt_token_hash: hashToken('old-attempt'),
        }),
      ],
      remediations: [{ id: REMEDIATION_ID, status: 'running' }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleFinding() as never);
    const cloudFetch = cloudAgentFetch();

    await expect(
      processRemediationAttempt({
        env: processEnv(cloudFetch),
        attemptId: ATTEMPT_ID,
        dispatchId: 'dispatch-1',
      })
    ).resolves.toBe('launched');

    expect(cloudFetch).toHaveBeenCalledTimes(2);
    expect(String(cloudFetch.mock.calls[1]?.[0]?.url)).toContain('/initiateFromKilocodeSessionV2');
    expect(state.attempt()).toMatchObject({
      status: 'running',
      cloud_agent_session_id: 'prepared-session',
      kilo_session_id: 'kilo-session',
      execution_id: 'execution-1',
    });
    expect(state.remediation()).toMatchObject({ status: 'running' });
  });

  it('can requeue an owned running attempt after initiation fails', async () => {
    const state = createRecordingDb({
      attempts: [launchAttemptRow()],
      remediations: [{ id: REMEDIATION_ID, status: 'queued' }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleFinding() as never);
    const cloudFetch = cloudAgentFetch({ initiateStatus: 500 });

    await expect(
      processRemediationAttempt({
        env: processEnv(cloudFetch),
        attemptId: ATTEMPT_ID,
        dispatchId: 'dispatch-1',
      })
    ).resolves.toBe('failed');

    const failureUpdate = state.updates.find(
      update => update.values.failure_code === 'LAUNCH_UPSTREAM_5XX'
    );
    const query = compiled(failureUpdate?.condition);
    expect(query.sql).toContain('"security_remediation_attempts"."claim_token" =');
    expect(query.sql).toContain('"security_remediation_attempts"."status" in');
    expect(query.sql).not.toContain('"cloud_agent_session_id" is null');
    expect(query.sql).not.toContain('"kilo_session_id" is null');
    expect(query.sql).not.toContain('"execution_id" is null');
    expect(query.sql).not.toContain('"launched_at" is null');
    expect(query.sql).not.toContain('"callback_attempt_token_hash" is null');

    expect(state.attempt()).toMatchObject({
      status: 'queued',
      failure_code: 'LAUNCH_UPSTREAM_5XX',
      cloud_agent_session_id: 'prepared-session',
      launch_attempt_count: 1,
    });
    expect(state.remediation()).toMatchObject({ status: 'running' });
  });

  it('fences old-worker cancellation so it cannot overwrite a successor', async () => {
    const state = createRecordingDb({
      attempts: [launchAttemptRow()],
      remediations: [{ id: REMEDIATION_ID, status: 'queued' }],
      cancellationRequestedAt: OLD,
      afterClaim: attempt => {
        attempt.claim_token = 'successor-claim';
      },
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleFinding() as never);
    vi.mocked(insertSecurityFindingAuditEvent).mockClear();
    const cloudFetch = cloudAgentFetch();

    await expect(
      processRemediationAttempt({
        env: processEnv(cloudFetch),
        attemptId: ATTEMPT_ID,
        dispatchId: 'dispatch-1',
      })
    ).resolves.toBe('skipped');

    const cancellation = state.updates.find(update => update.values.status === 'cancelled');
    const query = compiled(cancellation?.condition);
    expect(query.sql).toContain('"security_remediation_attempts"."claim_token" =');
    expect(query.sql).toContain('"security_remediation_attempts"."status" =');

    expect(insertSecurityFindingAuditEvent).not.toHaveBeenCalled();
    expect(settleOperation).not.toHaveBeenCalled();
    expect(state.attempt()).toMatchObject({
      status: 'launching',
      claim_token: 'successor-claim',
    });
    expect(state.remediation()).toMatchObject({ status: 'queued' });
    expect(cloudFetch).toHaveBeenCalledTimes(1);
    expect(String(cloudFetch.mock.calls[0]?.[0]?.url)).toContain('/prepareSession');
  });

  it('honors cancellation during stale recovery and emits the terminal event', async () => {
    const state = createRecordingDb({
      attempts: [
        launchAttemptRow({
          status: 'launching',
          claim_token: 'stale-claim',
          claimed_at: OLD,
          cancellation_requested_at: OLD,
          launch_attempt_count: 1,
        }),
      ],
      remediations: [{ id: REMEDIATION_ID, status: 'queued' }],
      ledgerRow: { id: 'ledger-row-1' },
      userRow: { google_user_email: 'owner@example.com' },
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleFinding() as never);
    const lifecycleFetch = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 })
    );
    vi.stubGlobal('fetch', lifecycleFetch);

    await expect(
      recoverStaleRemediationLaunchAttempts(state.db as never, {
        env: processEnv(cloudAgentFetch()),
        claimedBefore: CUTOFF,
      })
    ).resolves.toEqual({ requeuedCount: 0, failedCount: 0, cancelledCount: 1 });

    const cancellation = state.updates.find(update => update.values.status === 'cancelled');
    const query = compiled(cancellation?.condition);
    expect(query.sql).toContain('"security_remediation_attempts"."claim_token" =');
    expect(query.sql).toContain('"security_remediation_attempts"."status" =');

    expect(state.attempt()).toMatchObject({ status: 'cancelled' });
    expect(state.remediation()).toMatchObject({ status: 'cancelled' });
    expect(insertSecurityFindingAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'security.remediation.cancelled' })
    );
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'interrupted' })
    );
    const lifecycleCall = lifecycleFetch.mock.calls[0];
    if (!lifecycleCall) throw new Error('Expected a lifecycle request');
    const lifecycleBody = JSON.parse((lifecycleCall[1] as RequestInit).body as string) as {
      event: string;
    };
    expect(lifecycleBody.event).toBe('remediation_cancelled');
  });

  it('fails terminally after the bounded stale launch attempts', async () => {
    const state = createRecordingDb({
      attempts: [
        launchAttemptRow({
          status: 'launching',
          claim_token: 'stale-claim',
          claimed_at: OLD,
          launch_attempt_count: 3,
        }),
      ],
      remediations: [{ id: REMEDIATION_ID, status: 'queued' }],
      ledgerRow: { id: 'ledger-row-1' },
      userRow: { google_user_email: 'owner@example.com' },
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);
    vi.mocked(getSecurityFindingById).mockResolvedValue(eligibleFinding() as never);
    const lifecycleFetch = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 })
    );
    vi.stubGlobal('fetch', lifecycleFetch);

    await expect(
      recoverStaleRemediationLaunchAttempts(state.db as never, {
        env: processEnv(cloudAgentFetch()),
        claimedBefore: CUTOFF,
      })
    ).resolves.toEqual({ requeuedCount: 0, failedCount: 1, cancelledCount: 0 });

    const failure = state.updates.find(
      update => update.values.failure_code === 'PRELAUNCH_TIMEOUT'
    );
    const query = compiled(failure?.condition);
    expect(query.sql).toContain('"security_remediation_attempts"."claim_token" =');
    expect(query.sql).toContain('"security_remediation_attempts"."status" =');
    expect(query.sql).toContain('"security_remediation_attempts"."claimed_at" <=');

    expect(state.attempt()).toMatchObject({
      status: 'failed',
      failure_code: 'PRELAUNCH_TIMEOUT',
      launch_attempt_count: 3,
    });
    expect(state.remediation()).toMatchObject({ status: 'failed' });
    expect(insertSecurityFindingAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'security.remediation.failed',
        metadata: expect.objectContaining({ failure_code: 'PRELAUNCH_TIMEOUT' }),
      })
    );
    expect(settleOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed' })
    );
    const lifecycleCall = lifecycleFetch.mock.calls[0];
    if (!lifecycleCall) throw new Error('Expected a lifecycle request');
    const lifecycleBody = JSON.parse((lifecycleCall[1] as RequestInit).body as string) as {
      event: string;
    };
    expect(lifecycleBody.event).toBe('remediation_failed');
  });

  it('continues sweeping after one row audit failure', async () => {
    const first = launchAttemptRow({
      status: 'launching',
      claim_token: 'first-claim',
      claimed_at: OLD,
      launch_attempt_count: 3,
    });
    const second = launchAttemptRow({
      id: SECOND_ATTEMPT_ID,
      finding_id: SECOND_FINDING_ID,
      remediation_id: SECOND_REMEDIATION_ID,
      status: 'launching',
      claim_token: 'second-claim',
      claimed_at: OLD,
      launch_attempt_count: 3,
    });
    const state = createRecordingDb({
      attempts: [first, second],
      remediations: [
        { id: REMEDIATION_ID, status: 'queued' },
        { id: SECOND_REMEDIATION_ID, status: 'queued' },
      ],
      ledgerRow: { id: 'ledger-row-1' },
      userRow: { google_user_email: 'owner@example.com' },
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);
    vi.mocked(getSecurityFindingById).mockImplementation(async (db, findingId) => {
      return eligibleFinding(String(findingId)) as never;
    });
    vi.mocked(insertSecurityFindingAuditEvent).mockImplementation(async (_db, event) => {
      const attemptId = (event as { metadata?: { attempt_id?: string } }).metadata?.attempt_id;
      if (attemptId === ATTEMPT_ID) throw new Error('audit write failed');
      return { inserted: true, id: 'audit-1' };
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 }))
    );

    await expect(
      recoverStaleRemediationLaunchAttempts(state.db as never, {
        env: processEnv(cloudAgentFetch()),
        claimedBefore: CUTOFF,
      })
    ).resolves.toEqual({ requeuedCount: 0, failedCount: 1, cancelledCount: 0 });

    expect(state.attempt(ATTEMPT_ID)).toMatchObject({ status: 'launching' });
    expect(state.attempt(SECOND_ATTEMPT_ID)).toMatchObject({ status: 'failed' });
  });

  it('rejects a callback for a different prepared session without mutating state', async () => {
    const attempt = launchAttemptRow({
      status: 'running',
      claim_token: 'claim-token-1',
      cloud_agent_session_id: 'prepared-session',
      kilo_session_id: 'kilo-session',
      callback_attempt_token_hash: hashToken('callback-token'),
      launched_at: OLD,
    });
    const state = createRecordingDb({
      attempts: [attempt],
      remediations: [{ id: REMEDIATION_ID, status: 'running' }],
    });
    vi.mocked(getWorkerDb).mockReturnValue(state.db as never);

    await expect(
      finalizeRemediationCallbackFromEnv({
        env: processEnv(cloudAgentFetch()),
        attemptId: ATTEMPT_ID,
        attemptToken: 'callback-token',
        payload: {
          sessionId: 'kilo-session',
          cloudAgentSessionId: 'other-session',
          executionId: 'execution-1',
          status: 'completed',
        },
      })
    ).resolves.toEqual({ status: 'stale-session' });

    expect(state.attempt()).toMatchObject({
      status: 'running',
      cloud_agent_session_id: 'prepared-session',
    });
    expect(state.remediation()).toMatchObject({ status: 'running' });
  });
});
