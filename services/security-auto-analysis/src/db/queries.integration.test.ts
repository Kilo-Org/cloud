import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  kilocode_users,
  security_analysis_owner_state,
  security_analysis_queue,
  security_findings,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import {
  discoverDueOwners,
  ensureManualAnalysisQueueRow,
  getSecurityFindingById,
  reconcileStaleAnalysisQueueRows,
} from './queries.js';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const testUserId = `security-auto-analysis-db-${randomUUID()}`;
const testFindingIds: string[] = [];
let client: ReturnType<typeof createDrizzleClient>;

describe('security analysis durable database invariants', () => {
  beforeAll(async () => {
    client = createDrizzleClient({ connectionString, ssl: false });
    await client.db.insert(kilocode_users).values({
      id: testUserId,
      google_user_email: `${testUserId}@example.com`,
      google_user_name: 'Security Auto Analysis DB Test',
      google_user_image_url: 'https://example.com/avatar.png',
      stripe_customer_id: `cus_${randomUUID()}`,
    });
  });

  afterEach(async () => {
    if (testFindingIds.length === 0) return;
    const ids = testFindingIds.splice(0, testFindingIds.length);
    await client.db
      .delete(security_analysis_queue)
      .where(inArray(security_analysis_queue.finding_id, ids));
    await client.db
      .delete(security_analysis_owner_state)
      .where(eq(security_analysis_owner_state.owned_by_user_id, testUserId));
    await client.db.delete(security_findings).where(inArray(security_findings.id, ids));
  });

  afterAll(async () => {
    await client.db.delete(kilocode_users).where(eq(kilocode_users.id, testUserId));
    await client.pool.end();
  });

  it('enforces one manual queue row per finding against Postgres constraints', async () => {
    const findingId = await insertFinding('manual-unique');
    const finding = await getSecurityFindingById(client.db as never, findingId);
    expect(finding).not.toBeNull();
    if (!finding) return;

    await expect(
      ensureManualAnalysisQueueRow(client.db as never, {
        finding,
        claimToken: 'claim-token-one',
        jobId: 'manual-job-one',
      })
    ).resolves.toBe(true);
    await expect(
      ensureManualAnalysisQueueRow(client.db as never, {
        finding,
        claimToken: 'claim-token-two',
        jobId: 'manual-job-two',
      })
    ).resolves.toBe(false);

    const queueRows = await client.db
      .select({
        queueStatus: security_analysis_queue.queue_status,
        claimToken: security_analysis_queue.claim_token,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, findingId));
    expect(queueRows).toEqual([{ queueStatus: 'pending', claimToken: 'claim-token-one' }]);
  });

  it('revives terminal manual queue rows so users can rerun analysis after completion', async () => {
    const findingId = await insertFinding('manual-rerun');
    const finding = await getSecurityFindingById(client.db as never, findingId);
    expect(finding).not.toBeNull();
    if (!finding) return;

    await expect(
      ensureManualAnalysisQueueRow(client.db as never, {
        finding,
        claimToken: 'claim-token-first',
        jobId: 'manual-job-first',
      })
    ).resolves.toBe(true);
    // Simulate the prior manual run reaching a terminal state with retry
    // metadata that must be cleared on rerun.
    await client.db
      .update(security_analysis_queue)
      .set({
        queue_status: 'failed',
        failure_code: 'START_CALL_AMBIGUOUS',
        last_error_redacted: 'prior failure',
        attempt_count: 2,
      })
      .where(eq(security_analysis_queue.finding_id, findingId));

    await expect(
      ensureManualAnalysisQueueRow(client.db as never, {
        finding,
        claimToken: 'claim-token-rerun',
        jobId: 'manual-job-rerun',
      })
    ).resolves.toBe(true);

    const queueRows = await client.db
      .select({
        queueStatus: security_analysis_queue.queue_status,
        claimToken: security_analysis_queue.claim_token,
        claimedByJobId: security_analysis_queue.claimed_by_job_id,
        failureCode: security_analysis_queue.failure_code,
        lastErrorRedacted: security_analysis_queue.last_error_redacted,
        attemptCount: security_analysis_queue.attempt_count,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, findingId));
    expect(queueRows).toEqual([
      {
        queueStatus: 'pending',
        claimToken: 'claim-token-rerun',
        claimedByJobId: 'manual-job-rerun',
        failureCode: null,
        lastErrorRedacted: null,
        attemptCount: 0,
      },
    ]);
  });

  it('lets manual retry supersede an unclaimed scheduled retry', async () => {
    const findingId = await insertFinding('manual-supersedes-scheduled-retry', 'failed');
    const finding = await getSecurityFindingById(client.db as never, findingId);
    expect(finding).not.toBeNull();
    if (!finding) return;

    await client.db.insert(security_analysis_queue).values({
      finding_id: findingId,
      owned_by_user_id: testUserId,
      queue_status: 'queued',
      severity_rank: 1,
      queued_at: '2026-05-18T08:00:00.000Z',
      attempt_count: 2,
      next_retry_at: '2026-05-18T09:00:00.000Z',
      failure_code: 'NETWORK_TIMEOUT',
      last_error_redacted: 'prior scheduled failure',
    });

    await expect(
      ensureManualAnalysisQueueRow(client.db as never, {
        finding,
        claimToken: 'manual-claim-token',
        jobId: 'manual-job',
      })
    ).resolves.toBe(true);

    const queueRows = await client.db
      .select({
        queueStatus: security_analysis_queue.queue_status,
        claimToken: security_analysis_queue.claim_token,
        claimedByJobId: security_analysis_queue.claimed_by_job_id,
        failureCode: security_analysis_queue.failure_code,
        lastErrorRedacted: security_analysis_queue.last_error_redacted,
        attemptCount: security_analysis_queue.attempt_count,
        nextRetryAt: security_analysis_queue.next_retry_at,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, findingId));
    expect(queueRows).toEqual([
      {
        queueStatus: 'pending',
        claimToken: 'manual-claim-token',
        claimedByJobId: 'manual-job',
        failureCode: null,
        lastErrorRedacted: null,
        attemptCount: 0,
        nextRetryAt: null,
      },
    ]);
  });

  it('requeues stale pending rows and terminalizes stale running rows in real SQL', async () => {
    const pendingFindingId = await insertFinding('stale-pending');
    const runningFindingId = await insertFinding('stale-running', 'running');
    await client.db.insert(security_analysis_queue).values([
      {
        finding_id: pendingFindingId,
        owned_by_user_id: testUserId,
        queue_status: 'pending',
        severity_rank: 1,
        queued_at: '2026-05-18T08:00:00.000Z',
        claimed_at: '2026-05-18T08:00:00.000Z',
        claimed_by_job_id: 'pending-job',
        claim_token: 'pending-claim',
        updated_at: '2026-05-18T08:00:00.000Z',
      },
      {
        finding_id: runningFindingId,
        owned_by_user_id: testUserId,
        queue_status: 'running',
        severity_rank: 1,
        queued_at: '2026-05-18T06:00:00.000Z',
        claimed_at: '2026-05-18T06:00:00.000Z',
        claimed_by_job_id: 'running-job',
        claim_token: 'running-claim',
        updated_at: '2026-05-18T06:00:00.000Z',
      },
    ]);

    await expect(reconcileStaleAnalysisQueueRows(client.db as never)).resolves.toEqual({
      requeuedPendingCount: 1,
      failedRunningCount: 1,
    });

    const queueRows = await client.db
      .select({
        findingId: security_analysis_queue.finding_id,
        status: security_analysis_queue.queue_status,
        failureCode: security_analysis_queue.failure_code,
      })
      .from(security_analysis_queue)
      .where(inArray(security_analysis_queue.finding_id, [pendingFindingId, runningFindingId]));
    expect(queueRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingId: pendingFindingId,
          status: 'queued',
          failureCode: null,
        }),
        expect.objectContaining({
          findingId: runningFindingId,
          status: 'failed',
          failureCode: 'RUN_LOST',
        }),
      ])
    );
  });

  it('heals stale running queue state without downgrading a completed finding', async () => {
    const completedFindingId = await insertFinding('stale-running-completed', 'completed');
    await client.db.insert(security_analysis_queue).values({
      finding_id: completedFindingId,
      owned_by_user_id: testUserId,
      queue_status: 'running',
      severity_rank: 1,
      queued_at: '2026-05-18T06:00:00.000Z',
      claimed_at: '2026-05-18T06:00:00.000Z',
      claimed_by_job_id: 'completed-running-job',
      claim_token: 'completed-running-claim',
      updated_at: '2026-05-18T06:00:00.000Z',
    });

    await expect(reconcileStaleAnalysisQueueRows(client.db as never)).resolves.toEqual({
      requeuedPendingCount: 0,
      failedRunningCount: 0,
    });

    const findingRows = await client.db
      .select({
        analysisStatus: security_findings.analysis_status,
        analysisError: security_findings.analysis_error,
      })
      .from(security_findings)
      .where(eq(security_findings.id, completedFindingId));
    expect(findingRows).toEqual([{ analysisStatus: 'completed', analysisError: null }]);

    const queueRows = await client.db
      .select({
        status: security_analysis_queue.queue_status,
        failureCode: security_analysis_queue.failure_code,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, completedFindingId));
    expect(queueRows).toEqual([{ status: 'completed', failureCode: null }]);
  });

  it('preserves a failed terminal finding while settling stale running queue state', async () => {
    const failedFindingId = await insertFinding('stale-running-failed', 'failed');
    await client.db
      .update(security_findings)
      .set({ analysis_error: 'Callback failure already committed' })
      .where(eq(security_findings.id, failedFindingId));
    await client.db.insert(security_analysis_queue).values({
      finding_id: failedFindingId,
      owned_by_user_id: testUserId,
      queue_status: 'running',
      severity_rank: 1,
      queued_at: '2026-05-18T06:00:00.000Z',
      claimed_at: '2026-05-18T06:00:00.000Z',
      claimed_by_job_id: 'failed-running-job',
      claim_token: 'failed-running-claim',
      updated_at: '2026-05-18T06:00:00.000Z',
    });

    await expect(reconcileStaleAnalysisQueueRows(client.db as never)).resolves.toEqual({
      requeuedPendingCount: 0,
      failedRunningCount: 0,
    });

    const findingRows = await client.db
      .select({
        analysisStatus: security_findings.analysis_status,
        analysisError: security_findings.analysis_error,
      })
      .from(security_findings)
      .where(eq(security_findings.id, failedFindingId));
    expect(findingRows).toEqual([
      { analysisStatus: 'failed', analysisError: 'Callback failure already committed' },
    ]);

    const queueRows = await client.db
      .select({ status: security_analysis_queue.queue_status })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, failedFindingId));
    expect(queueRows).toEqual([{ status: 'failed' }]);
  });

  it('preserves a failed terminal finding while settling stale pending queue state', async () => {
    const failedFindingId = await insertFinding('stale-pending-failed', 'failed');
    await client.db
      .update(security_findings)
      .set({ analysis_error: 'Start failure already committed' })
      .where(eq(security_findings.id, failedFindingId));
    await client.db.insert(security_analysis_queue).values({
      finding_id: failedFindingId,
      owned_by_user_id: testUserId,
      queue_status: 'pending',
      severity_rank: 1,
      queued_at: '2026-05-18T08:00:00.000Z',
      claimed_at: '2026-05-18T08:00:00.000Z',
      claimed_by_job_id: 'failed-pending-job',
      claim_token: 'failed-pending-claim',
      updated_at: '2026-05-18T08:00:00.000Z',
    });

    await expect(reconcileStaleAnalysisQueueRows(client.db as never)).resolves.toEqual({
      requeuedPendingCount: 0,
      failedRunningCount: 0,
    });

    const findingRows = await client.db
      .select({
        analysisStatus: security_findings.analysis_status,
        analysisError: security_findings.analysis_error,
      })
      .from(security_findings)
      .where(eq(security_findings.id, failedFindingId));
    expect(findingRows).toEqual([
      { analysisStatus: 'failed', analysisError: 'Start failure already committed' },
    ]);

    const queueRows = await client.db
      .select({ status: security_analysis_queue.queue_status })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, failedFindingId));
    expect(queueRows).toEqual([{ status: 'failed' }]);
  });

  it('promotes a stale pending queue row when launch already advanced the finding to running', async () => {
    const runningFindingId = await insertFinding('stale-pending-running', 'running');
    await client.db.insert(security_analysis_queue).values({
      finding_id: runningFindingId,
      owned_by_user_id: testUserId,
      queue_status: 'pending',
      severity_rank: 1,
      queued_at: '2026-05-18T08:00:00.000Z',
      claimed_at: '2026-05-18T08:00:00.000Z',
      claimed_by_job_id: 'pending-running-job',
      claim_token: 'pending-running-claim',
      updated_at: '2026-05-18T08:00:00.000Z',
    });

    await expect(reconcileStaleAnalysisQueueRows(client.db as never)).resolves.toEqual({
      requeuedPendingCount: 0,
      failedRunningCount: 0,
    });

    const findingRows = await client.db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, runningFindingId));
    expect(findingRows).toEqual([{ analysisStatus: 'running' }]);

    const queueRows = await client.db
      .select({
        status: security_analysis_queue.queue_status,
        claimToken: security_analysis_queue.claim_token,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, runningFindingId));
    expect(queueRows).toEqual([{ status: 'running', claimToken: 'pending-running-claim' }]);
  });

  it('heals a stale pending queue row when triage completion reached durable finding state', async () => {
    const completedFindingId = await insertFinding('stale-pending-completed', 'completed');
    await client.db.insert(security_analysis_queue).values({
      finding_id: completedFindingId,
      owned_by_user_id: testUserId,
      queue_status: 'pending',
      severity_rank: 1,
      queued_at: '2026-05-18T08:00:00.000Z',
      claimed_at: '2026-05-18T08:00:00.000Z',
      claimed_by_job_id: 'pending-completed-job',
      claim_token: 'pending-completed-claim',
      updated_at: '2026-05-18T08:00:00.000Z',
    });

    await expect(reconcileStaleAnalysisQueueRows(client.db as never)).resolves.toEqual({
      requeuedPendingCount: 0,
      failedRunningCount: 0,
    });

    const findingRows = await client.db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, completedFindingId));
    expect(findingRows).toEqual([{ analysisStatus: 'completed' }]);

    const queueRows = await client.db
      .select({
        status: security_analysis_queue.queue_status,
        failureCode: security_analysis_queue.failure_code,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, completedFindingId));
    expect(queueRows).toEqual([{ status: 'completed', failureCode: null }]);
  });

  it('does not mark a stale running queue row lost when finding state has not reached running', async () => {
    const pendingFindingId = await insertFinding('stale-running-pending', 'pending');
    await client.db.insert(security_analysis_queue).values({
      finding_id: pendingFindingId,
      owned_by_user_id: testUserId,
      queue_status: 'running',
      severity_rank: 1,
      queued_at: '2026-05-18T06:00:00.000Z',
      claimed_at: '2026-05-18T06:00:00.000Z',
      claimed_by_job_id: 'running-pending-job',
      claim_token: 'running-pending-claim',
      updated_at: '2026-05-18T06:00:00.000Z',
    });

    await expect(reconcileStaleAnalysisQueueRows(client.db as never)).resolves.toEqual({
      requeuedPendingCount: 0,
      failedRunningCount: 0,
    });

    const findingRows = await client.db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, pendingFindingId));
    expect(findingRows).toEqual([{ analysisStatus: 'pending' }]);

    const queueRows = await client.db
      .select({ status: security_analysis_queue.queue_status })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, pendingFindingId));
    expect(queueRows).toEqual([{ status: 'running' }]);
  });

  it('leaves fresh pending and running rows untouched in real SQL', async () => {
    const currentTimestamp = new Date(Date.now() - 60_000).toISOString();
    const pendingFindingId = await insertFinding('fresh-pending');
    const runningFindingId = await insertFinding('fresh-running', 'running');
    await client.db.insert(security_analysis_queue).values([
      {
        finding_id: pendingFindingId,
        owned_by_user_id: testUserId,
        queue_status: 'pending',
        severity_rank: 1,
        queued_at: currentTimestamp,
        claimed_at: currentTimestamp,
        claimed_by_job_id: 'fresh-pending-job',
        claim_token: 'fresh-pending-claim',
        updated_at: currentTimestamp,
      },
      {
        finding_id: runningFindingId,
        owned_by_user_id: testUserId,
        queue_status: 'running',
        severity_rank: 1,
        queued_at: currentTimestamp,
        claimed_at: currentTimestamp,
        claimed_by_job_id: 'fresh-running-job',
        claim_token: 'fresh-running-claim',
        updated_at: currentTimestamp,
      },
    ]);

    await expect(reconcileStaleAnalysisQueueRows(client.db as never)).resolves.toEqual({
      requeuedPendingCount: 0,
      failedRunningCount: 0,
    });

    const queueRows = await client.db
      .select({
        findingId: security_analysis_queue.finding_id,
        status: security_analysis_queue.queue_status,
        claimToken: security_analysis_queue.claim_token,
      })
      .from(security_analysis_queue)
      .where(inArray(security_analysis_queue.finding_id, [pendingFindingId, runningFindingId]));
    expect(queueRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingId: pendingFindingId,
          status: 'pending',
          claimToken: 'fresh-pending-claim',
        }),
        expect.objectContaining({
          findingId: runningFindingId,
          status: 'running',
          claimToken: 'fresh-running-claim',
        }),
      ])
    );
  });

  it('keeps owner block state intact while stale pending work is requeued', async () => {
    const staleFindingId = await insertFinding('blocked-stale-pending');
    await client.db.insert(security_analysis_owner_state).values({
      owned_by_user_id: testUserId,
      blocked_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      block_reason: 'OPERATOR_PAUSE',
      consecutive_actor_resolution_failures: 2,
    });
    await client.db.insert(security_analysis_queue).values({
      finding_id: staleFindingId,
      owned_by_user_id: testUserId,
      queue_status: 'pending',
      severity_rank: 1,
      queued_at: '2026-05-18T08:00:00.000Z',
      claimed_at: '2026-05-18T08:00:00.000Z',
      claimed_by_job_id: 'blocked-pending-job',
      claim_token: 'blocked-pending-claim',
      updated_at: '2026-05-18T08:00:00.000Z',
    });

    await expect(reconcileStaleAnalysisQueueRows(client.db as never)).resolves.toEqual({
      requeuedPendingCount: 1,
      failedRunningCount: 0,
    });

    const ownerStates = await client.db
      .select({
        reason: security_analysis_owner_state.block_reason,
        failures: security_analysis_owner_state.consecutive_actor_resolution_failures,
      })
      .from(security_analysis_owner_state)
      .where(eq(security_analysis_owner_state.owned_by_user_id, testUserId));
    expect(ownerStates).toEqual([{ reason: 'OPERATOR_PAUSE', failures: 2 }]);
    await expect(discoverDueOwners(client.db as never, 10)).resolves.not.toContainEqual({
      type: 'user',
      id: testUserId,
    });
  });
});

async function insertFinding(
  suffix: string,
  analysisStatus: string | null = 'pending'
): Promise<string> {
  const findingId = randomUUID();
  testFindingIds.push(findingId);
  await client.db.insert(security_findings).values({
    id: findingId,
    owned_by_user_id: testUserId,
    repo_full_name: `kilo/${suffix}`,
    source: 'dependabot',
    source_id: suffix,
    severity: 'high',
    package_name: `package-${suffix}`,
    package_ecosystem: 'npm',
    title: `Finding ${suffix}`,
    status: 'open',
    analysis_status: analysisStatus,
  });
  return findingId;
}
