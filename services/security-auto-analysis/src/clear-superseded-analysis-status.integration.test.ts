import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { createDrizzleClient } from '@kilocode/db/client';
import { kilocode_users, security_analysis_queue, security_findings } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { clearSupersededAnalysisStatus } from './db/queries.js';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const testUserId = `security-analysis-clear-superseded-${randomUUID()}`;
const testFindingIds: string[] = [];
let client: ReturnType<typeof createDrizzleClient>;

describe('clearSupersededAnalysisStatus', () => {
  beforeAll(async () => {
    client = createDrizzleClient({ connectionString, ssl: false });
    await client.db.insert(kilocode_users).values({
      id: testUserId,
      google_user_email: `${testUserId}@example.com`,
      google_user_name: 'Security Analysis Clear Superseded Test',
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

  it("clears analysis_status while this attempt's claim still owns the queue row", async () => {
    const findingId = await insertFinding('clear-own-claim');
    await insertQueueClaim({
      findingId,
      claimToken: 'clear-own-claim-token',
      jobId: 'clear-own-claim-job',
    });

    await clearSupersededAnalysisStatus(client.db as never, {
      findingId,
      claimToken: 'clear-own-claim-token',
    });

    await expect(readAnalysisStatus(findingId)).resolves.toBeNull();
  });

  it('keeps analysis_status when a newer claim owns the queue row', async () => {
    const findingId = await insertFinding('clear-newer-claim');
    await insertQueueClaim({
      findingId,
      claimToken: 'clear-newer-claim-token',
      jobId: 'clear-newer-claim-job',
    });

    await clearSupersededAnalysisStatus(client.db as never, {
      findingId,
      claimToken: 'clear-superseded-claim-token',
    });

    await expect(readAnalysisStatus(findingId)).resolves.toBe('running');
  });
});

async function readAnalysisStatus(findingId: string) {
  const rows = await client.db
    .select({ analysisStatus: security_findings.analysis_status })
    .from(security_findings)
    .where(eq(security_findings.id, findingId));
  return rows[0]?.analysisStatus ?? null;
}

async function insertFinding(suffix: string): Promise<string> {
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
    analysis_status: 'running',
  });
  return findingId;
}

async function insertQueueClaim(params: {
  findingId: string;
  claimToken: string;
  jobId: string;
}): Promise<void> {
  const claimedAt = new Date().toISOString();
  await client.db.insert(security_analysis_queue).values({
    finding_id: params.findingId,
    owned_by_user_id: testUserId,
    queue_status: 'running',
    severity_rank: 1,
    queued_at: claimedAt,
    claimed_at: claimedAt,
    claimed_by_job_id: params.jobId,
    claim_token: params.claimToken,
  });
}
