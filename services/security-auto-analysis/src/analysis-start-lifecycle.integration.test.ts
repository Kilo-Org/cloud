import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { createDrizzleClient } from '@kilocode/db/client';
import { kilocode_users, security_analysis_queue, security_findings } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import {
  transitionAnalysisCallbackLifecycle,
  transitionAnalysisStartLifecycle,
} from './analysis-start-lifecycle.js';
import type { SecurityFindingAnalysis } from './types.js';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const testUserId = `security-analysis-start-lifecycle-${randomUUID()}`;
const testFindingIds: string[] = [];
let client: ReturnType<typeof createDrizzleClient>;

describe('analysis start lifecycle durable transitions', () => {
  beforeAll(async () => {
    client = createDrizzleClient({ connectionString, ssl: false });
    await client.db.insert(kilocode_users).values({
      id: testUserId,
      google_user_email: `${testUserId}@example.com`,
      google_user_name: 'Security Analysis Lifecycle Test',
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
    await client.db.delete(security_findings).where(inArray(security_findings.id, ids));
  });

  afterAll(async () => {
    await client.db.delete(kilocode_users).where(eq(kilocode_users.id, testUserId));
    await client.pool.end();
  });

  it('completes manual triage-only starts with queue and finding state settled together', async () => {
    const findingId = await insertFinding('manual-triage-complete');
    await insertQueueClaim({
      findingId,
      claimToken: 'manual-triage-claim',
      jobId: 'manual-triage-job',
    });
    const analysis = createAnalysis('manual-triage-complete');

    await expect(
      transitionAnalysisStartLifecycle(client.db as never, {
        claim: {
          source: 'manual',
          findingId,
          claimToken: 'manual-triage-claim',
        },
        outcome: {
          type: 'triage-only-completed',
          analysis,
        },
      })
    ).resolves.toEqual({ transitioned: true });

    const findingRows = await client.db
      .select({
        analysisStatus: security_findings.analysis_status,
        analysis: security_findings.analysis,
      })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(findingRows).toEqual([
      expect.objectContaining({
        analysisStatus: 'completed',
        analysis: expect.objectContaining({ correlationId: analysis.correlationId }),
      }),
    ]);

    const queueRows = await client.db
      .select({ status: security_analysis_queue.queue_status })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, findingId));
    expect(queueRows).toEqual([{ status: 'completed' }]);
  });

  it('terminalizes completed callbacks with queue and finding state settled together', async () => {
    const findingId = await insertFinding('callback-completed', 'running');
    await insertQueueClaim({
      findingId,
      claimToken: 'callback-completed-claim',
      jobId: 'callback-completed-job',
      queueStatus: 'running',
    });
    const analysis = createAnalysis('callback-completed');

    await expect(
      transitionAnalysisCallbackLifecycle(client.db as never, {
        findingId,
        attemptToken: 'callback-completed-claim',
        outcome: {
          type: 'completed',
          analysis,
        },
      })
    ).resolves.toEqual({ status: 'completed' });

    const findingRows = await client.db
      .select({
        analysisStatus: security_findings.analysis_status,
        analysis: security_findings.analysis,
      })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(findingRows).toEqual([
      expect.objectContaining({
        analysisStatus: 'completed',
        analysis: expect.objectContaining({ correlationId: analysis.correlationId }),
      }),
    ]);

    const queueRows = await client.db
      .select({
        status: security_analysis_queue.queue_status,
        failureCode: security_analysis_queue.failure_code,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, findingId));
    expect(queueRows).toEqual([{ status: 'completed', failureCode: null }]);
  });

  it('terminalizes failed callbacks with queue and finding failure state settled together', async () => {
    const findingId = await insertFinding('callback-failed', 'running');
    await insertQueueClaim({
      findingId,
      claimToken: 'callback-failed-claim',
      jobId: 'callback-failed-job',
      queueStatus: 'running',
    });

    await expect(
      transitionAnalysisCallbackLifecycle(client.db as never, {
        findingId,
        attemptToken: 'callback-failed-claim',
        outcome: {
          type: 'failed',
          errorMessage: 'upstream 503',
          failureCode: 'UPSTREAM_5XX',
        },
      })
    ).resolves.toEqual({ status: 'failed' });

    const findingRows = await client.db
      .select({
        analysisStatus: security_findings.analysis_status,
        analysisError: security_findings.analysis_error,
      })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(findingRows).toEqual([{ analysisStatus: 'failed', analysisError: 'upstream 503' }]);

    const queueRows = await client.db
      .select({
        status: security_analysis_queue.queue_status,
        failureCode: security_analysis_queue.failure_code,
        lastError: security_analysis_queue.last_error_redacted,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, findingId));
    expect(queueRows).toEqual([
      { status: 'failed', failureCode: 'UPSTREAM_5XX', lastError: 'upstream 503' },
    ]);
  });

  it('clears superseded callback capacity while settling its queue row', async () => {
    const findingId = await insertFinding('callback-superseded', 'running');
    await client.db
      .update(security_findings)
      .set({ ignored_reason: 'superseded:canonical-finding' })
      .where(eq(security_findings.id, findingId));
    await insertQueueClaim({
      findingId,
      claimToken: 'callback-superseded-claim',
      jobId: 'callback-superseded-job',
      queueStatus: 'running',
    });

    await expect(
      transitionAnalysisCallbackLifecycle(client.db as never, {
        findingId,
        attemptToken: 'callback-superseded-claim',
        outcome: { type: 'superseded' },
      })
    ).resolves.toEqual({ status: 'superseded' });

    const findingRows = await client.db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(findingRows).toEqual([{ analysisStatus: null }]);

    const queueRows = await client.db
      .select({
        status: security_analysis_queue.queue_status,
        failureCode: security_analysis_queue.failure_code,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, findingId));
    expect(queueRows).toEqual([{ status: 'completed', failureCode: 'SKIPPED_NO_LONGER_ELIGIBLE' }]);
  });

  it('settles completion races that find the callback superseded at terminal write time', async () => {
    const findingId = await insertFinding('callback-superseded-completion-race', 'running');
    await client.db
      .update(security_findings)
      .set({ ignored_reason: 'superseded:replacement-finding' })
      .where(eq(security_findings.id, findingId));
    await insertQueueClaim({
      findingId,
      claimToken: 'callback-superseded-completion-race-claim',
      jobId: 'callback-superseded-completion-race-job',
      queueStatus: 'running',
    });

    await expect(
      transitionAnalysisCallbackLifecycle(client.db as never, {
        findingId,
        attemptToken: 'callback-superseded-completion-race-claim',
        outcome: {
          type: 'completed',
          analysis: createAnalysis('callback-superseded-completion-race'),
        },
      })
    ).resolves.toEqual({ status: 'superseded' });

    const findingRows = await client.db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(findingRows).toEqual([{ analysisStatus: null }]);

    const queueRows = await client.db
      .select({
        status: security_analysis_queue.queue_status,
        failureCode: security_analysis_queue.failure_code,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, findingId));
    expect(queueRows).toEqual([{ status: 'completed', failureCode: 'SKIPPED_NO_LONGER_ELIGIBLE' }]);
  });

  it('heals stale running queue state on retried already-terminal completed callbacks', async () => {
    const findingId = await insertFinding('callback-partial-completion', 'running');
    await client.db
      .update(security_findings)
      .set({ analysis_status: 'completed' })
      .where(eq(security_findings.id, findingId));
    await insertQueueClaim({
      findingId,
      claimToken: 'callback-partial-completion-claim',
      jobId: 'callback-partial-completion-job',
      queueStatus: 'running',
    });

    await expect(
      transitionAnalysisCallbackLifecycle(client.db as never, {
        findingId,
        attemptToken: 'callback-partial-completion-claim',
        outcome: {
          type: 'already-terminal',
          findingStatus: 'completed',
          failureCode: null,
          errorMessage: null,
        },
      })
    ).resolves.toEqual({ status: 'already-terminal' });

    const findingRows = await client.db
      .select({ analysisStatus: security_findings.analysis_status })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(findingRows).toEqual([{ analysisStatus: 'completed' }]);

    const queueRows = await client.db
      .select({
        status: security_analysis_queue.queue_status,
        failureCode: security_analysis_queue.failure_code,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.finding_id, findingId));
    expect(queueRows).toEqual([{ status: 'completed', failureCode: null }]);
  });

  it('promotes scheduled sandbox starts to running without leaving the queue pending', async () => {
    const findingId = await insertFinding('scheduled-sandbox-running');
    const queueRowId = await insertQueueClaim({
      findingId,
      claimToken: 'scheduled-running-claim',
      jobId: 'scheduled-running-job',
    });

    await expect(
      transitionAnalysisStartLifecycle(client.db as never, {
        claim: {
          source: 'scheduled',
          findingId,
          queueRowId,
          claimToken: 'scheduled-running-claim',
        },
        outcome: {
          type: 'sandbox-running',
          cloudAgentSessionId: 'cloud-session-123',
          kiloSessionId: 'kilo-session-123',
        },
      })
    ).resolves.toEqual({ transitioned: true });

    const findingRows = await client.db
      .select({
        analysisStatus: security_findings.analysis_status,
        sessionId: security_findings.session_id,
        cliSessionId: security_findings.cli_session_id,
      })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(findingRows).toEqual([
      {
        analysisStatus: 'running',
        sessionId: 'cloud-session-123',
        cliSessionId: 'kilo-session-123',
      },
    ]);

    const queueRows = await client.db
      .select({
        status: security_analysis_queue.queue_status,
        attemptCount: security_analysis_queue.attempt_count,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.id, queueRowId));
    expect(queueRows).toEqual([{ status: 'running', attemptCount: 1 }]);
  });

  it('requeues retryable scheduled start failures after running promotion without split state', async () => {
    const findingId = await insertFinding('scheduled-retryable-failure', 'running');
    const queueRowId = await insertQueueClaim({
      findingId,
      claimToken: 'scheduled-retry-claim',
      jobId: 'scheduled-retry-job',
      queueStatus: 'running',
    });

    await expect(
      transitionAnalysisStartLifecycle(client.db as never, {
        claim: {
          source: 'scheduled',
          findingId,
          queueRowId,
          claimToken: 'scheduled-retry-claim',
        },
        outcome: {
          type: 'start-failed',
          errorMessage: 'prepareSession timed out',
          queueStatus: 'queued',
          failureCode: 'NETWORK_TIMEOUT',
          incrementAttempt: true,
          nextRetryAt: '2026-05-19T09:05:00.000Z',
        },
      })
    ).resolves.toEqual({ transitioned: true });

    const findingRows = await client.db
      .select({
        analysisStatus: security_findings.analysis_status,
        analysisError: security_findings.analysis_error,
      })
      .from(security_findings)
      .where(eq(security_findings.id, findingId));
    expect(findingRows).toEqual([
      {
        analysisStatus: 'failed',
        analysisError: 'prepareSession timed out',
      },
    ]);

    const queueRows = await client.db
      .select({
        status: security_analysis_queue.queue_status,
        attemptCount: security_analysis_queue.attempt_count,
        failureCode: security_analysis_queue.failure_code,
        nextRetryAt: security_analysis_queue.next_retry_at,
        claimToken: security_analysis_queue.claim_token,
      })
      .from(security_analysis_queue)
      .where(eq(security_analysis_queue.id, queueRowId));
    expect(queueRows).toEqual([
      {
        status: 'queued',
        attemptCount: 1,
        failureCode: 'NETWORK_TIMEOUT',
        nextRetryAt: expect.any(String),
        claimToken: null,
      },
    ]);
  });
});

async function insertFinding(
  suffix: string,
  analysisStatus: 'pending' | 'running' = 'pending'
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

async function insertQueueClaim(params: {
  findingId: string;
  claimToken: string;
  jobId: string;
  queueStatus?: 'pending' | 'running';
}): Promise<string> {
  const claimedAt = new Date().toISOString();
  const rows = await client.db
    .insert(security_analysis_queue)
    .values({
      finding_id: params.findingId,
      owned_by_user_id: testUserId,
      queue_status: params.queueStatus ?? 'pending',
      severity_rank: 1,
      queued_at: claimedAt,
      claimed_at: claimedAt,
      claimed_by_job_id: params.jobId,
      claim_token: params.claimToken,
    })
    .returning({ id: security_analysis_queue.id });
  const row = rows[0];
  if (!row) throw new Error('Expected queue row to be inserted');
  return row.id;
}

function createAnalysis(suffix: string): SecurityFindingAnalysis {
  return {
    triage: {
      needsSandboxAnalysis: false,
      needsSandboxReasoning: `No sandbox needed for ${suffix}`,
      suggestedAction: 'manual_review',
      confidence: 'high',
      triageAt: '2026-05-19T08:00:00.000Z',
    },
    analyzedAt: '2026-05-19T08:01:00.000Z',
    modelUsed: 'triage/model',
    triageModel: 'triage/model',
    analysisModel: 'analysis/model',
    triggeredByUserId: testUserId,
    correlationId: `correlation-${suffix}`,
  };
}
