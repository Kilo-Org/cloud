import { randomUUID } from 'crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  kilocode_users,
  security_findings,
  security_remediation_attempts,
  security_remediations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { discoverQueuedRemediationAttempts, processRemediationAttempt } from './remediation.js';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const client = createDrizzleClient({ connectionString, ssl: false });
const fixtureUserIds = new Set<string>();

function fixtureUserId(): string {
  const id = `security-remediation-discovery-${randomUUID()}`;
  fixtureUserIds.add(id);
  return id;
}

async function insertFixtureUser(id: string): Promise<void> {
  await client.db.insert(kilocode_users).values({
    id,
    google_user_email: `${id}@example.com`,
    google_user_name: 'Security remediation discovery test',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${randomUUID()}`,
  });
}

type AttemptSeed = {
  id?: string;
  ownerUserId: string;
  repoFullName: string;
  priority: number;
  status?: 'queued' | 'launching' | 'running';
  queuedAt?: string;
  nextRetryAt?: string | null;
};

function attemptRows(seeds: AttemptSeed[]) {
  const now = new Date().toISOString();
  const findings: (typeof security_findings.$inferInsert)[] = [];
  const remediations: (typeof security_remediations.$inferInsert)[] = [];
  const attempts: (typeof security_remediation_attempts.$inferInsert)[] = [];
  const ids: string[] = [];
  for (const seed of seeds) {
    const findingId = randomUUID();
    const remediationId = randomUUID();
    const attemptId = seed.id ?? randomUUID();
    ids.push(attemptId);
    findings.push({
      id: findingId,
      owned_by_user_id: seed.ownerUserId,
      repo_full_name: seed.repoFullName,
      source: 'dependabot',
      source_id: findingId,
      severity: 'high',
      package_name: `package-${findingId}`,
      package_ecosystem: 'npm',
      title: 'Fixture finding',
      status: 'open',
      analysis_status: 'completed',
    });
    remediations.push({
      id: remediationId,
      owned_by_user_id: seed.ownerUserId,
      finding_id: findingId,
      repo_full_name: seed.repoFullName,
      status: 'queued',
    });
    attempts.push({
      id: attemptId,
      remediation_id: remediationId,
      finding_id: findingId,
      owned_by_user_id: seed.ownerUserId,
      repo_full_name: seed.repoFullName,
      origin: 'bulk_existing',
      status: seed.status ?? 'queued',
      attempt_number: 1,
      analysis_fingerprint: 'fixture-fingerprint',
      analysis_completed_at: now,
      remediation_model_slug: 'anthropic/claude-opus-4.6',
      branch_name: `security-remediation/${attemptId}`,
      priority: seed.priority,
      queued_at: seed.queuedAt ?? now,
      next_retry_at: seed.nextRetryAt ?? null,
    });
  }
  return { findings, remediations, attempts, ids };
}

async function insertAttempts(seeds: AttemptSeed[]): Promise<string[]> {
  const rows = attemptRows(seeds);
  await client.db.insert(security_findings).values(rows.findings);
  await client.db.insert(security_remediations).values(rows.remediations);
  await client.db.insert(security_remediation_attempts).values(rows.attempts);
  return rows.ids;
}

async function attemptState(attemptId: string) {
  const [row] = await client.db
    .select({
      status: security_remediation_attempts.status,
      nextRetryAt: security_remediation_attempts.next_retry_at,
      launchAttemptCount: security_remediation_attempts.launch_attempt_count,
    })
    .from(security_remediation_attempts)
    .where(eq(security_remediation_attempts.id, attemptId));
  return row;
}

afterEach(async () => {
  for (const id of fixtureUserIds) {
    await client.db.delete(kilocode_users).where(eq(kilocode_users.id, id));
  }
  fixtureUserIds.clear();
});

afterAll(async () => {
  await client.pool.end();
});

describe('remediation attempt discovery against PostgreSQL', () => {
  it('discovers every involved owner before a second attempt of the same owner', async () => {
    const bulkOwner = fixtureUserId();
    const policyOwner = fixtureUserId();
    await insertFixtureUser(bulkOwner);
    await insertFixtureUser(policyOwner);
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    const bulkSeeds: AttemptSeed[] = Array.from({ length: 150 }, (_, index) => ({
      ownerUserId: bulkOwner,
      repoFullName: `kilo/bulk-${index}`,
      priority: 20,
      queuedAt: new Date(base + index * 1000).toISOString(),
    }));
    const bulkAttemptIds = await insertAttempts(bulkSeeds);
    const [policyAttemptId] = await insertAttempts([
      {
        ownerUserId: policyOwner,
        repoFullName: 'kilo/policy',
        priority: 50,
        queuedAt: new Date(base + 500_000).toISOString(),
      },
    ]);

    const discovered = await discoverQueuedRemediationAttempts(client.db as never, 100);

    expect(discovered).toHaveLength(100);
    expect(discovered[0]).toBe(bulkAttemptIds[0]);
    expect(discovered[1]).toBe(policyAttemptId);
    expect(discovered.filter(id => bulkAttemptIds.includes(id))).toHaveLength(99);
  });

  it('orders discovery by priority and queue age within one owner', async () => {
    const userId = fixtureUserId();
    await insertFixtureUser(userId);
    const [lowPriorityFirst] = await insertAttempts([
      {
        ownerUserId: userId,
        repoFullName: 'kilo/low-priority-earliest',
        priority: 50,
        queuedAt: '2026-03-01T00:00:00.000Z',
      },
    ]);
    const [highPriorityLater, highPriorityEarlier] = await insertAttempts([
      {
        ownerUserId: userId,
        repoFullName: 'kilo/high-priority-later',
        priority: 0,
        queuedAt: '2026-03-03T00:00:00.000Z',
      },
      {
        ownerUserId: userId,
        repoFullName: 'kilo/high-priority-earlier',
        priority: 0,
        queuedAt: '2026-03-02T00:00:00.000Z',
      },
    ]);

    const discovered = await discoverQueuedRemediationAttempts(client.db as never, 100);

    const ownerAttempts = discovered.filter(id =>
      [lowPriorityFirst, highPriorityLater, highPriorityEarlier].includes(id)
    );
    expect(ownerAttempts).toEqual([highPriorityEarlier, highPriorityLater, lowPriorityFirst]);
  });

  it('leaves out an owner whose attempt is already launching or running', async () => {
    const busyOwner = fixtureUserId();
    const idleOwner = fixtureUserId();
    await insertFixtureUser(busyOwner);
    await insertFixtureUser(idleOwner);
    await insertAttempts([
      {
        ownerUserId: busyOwner,
        repoFullName: 'kilo/busy-running',
        priority: 50,
        status: 'running',
      },
    ]);
    const busyQueuedIds = await insertAttempts(
      Array.from({ length: 3 }, (_, index) => ({
        ownerUserId: busyOwner,
        repoFullName: `kilo/busy-queued-${index}`,
        priority: 20,
      }))
    );
    const [idleAttemptId] = await insertAttempts([
      { ownerUserId: idleOwner, repoFullName: 'kilo/idle', priority: 50 },
    ]);

    const discovered = await discoverQueuedRemediationAttempts(client.db as never, 100);

    expect(discovered).toContain(idleAttemptId);
    for (const id of busyQueuedIds) expect(discovered).not.toContain(id);
  });

  it('defers an attempt whose owner becomes active after discovery', async () => {
    const userId = fixtureUserId();
    await insertFixtureUser(userId);
    const [queuedAttemptId] = await insertAttempts([
      { ownerUserId: userId, repoFullName: 'kilo/owner-race', priority: 20 },
    ]);
    expect(await discoverQueuedRemediationAttempts(client.db as never, 100)).toContain(
      queuedAttemptId
    );
    const [activeAttemptId] = await insertAttempts([
      {
        ownerUserId: userId,
        repoFullName: 'kilo/owner-race-active',
        priority: 0,
        status: 'launching',
      },
    ]);

    const outcome = await processRemediationAttempt({
      env: { HYPERDRIVE: { connectionString } } as unknown as CloudflareEnv,
      attemptId: queuedAttemptId,
      dispatchId: 'dispatch-owner-race',
    });

    expect(outcome).toBe('skipped');
    const state = await attemptState(queuedAttemptId);
    expect(state).toMatchObject({ status: 'queued', launchAttemptCount: 0 });
    const deferredUntil = Date.parse(String(state?.nextRetryAt));
    expect(deferredUntil).toBeGreaterThan(Date.now() + 30_000);
    expect(deferredUntil).toBeLessThan(Date.now() + 120_000);
    expect(await discoverQueuedRemediationAttempts(client.db as never, 100)).not.toContain(
      queuedAttemptId
    );

    await client.db
      .update(security_remediation_attempts)
      .set({ next_retry_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(security_remediation_attempts.id, queuedAttemptId));
    await client.db
      .update(security_remediation_attempts)
      .set({ status: 'failed' })
      .where(eq(security_remediation_attempts.id, activeAttemptId));
    expect(await discoverQueuedRemediationAttempts(client.db as never, 100)).toContain(
      queuedAttemptId
    );
  });

  it('defers an attempt whose repository another owner is already working on', async () => {
    const blockedOwner = fixtureUserId();
    const activeOwner = fixtureUserId();
    await insertFixtureUser(blockedOwner);
    await insertFixtureUser(activeOwner);
    await insertAttempts([
      {
        ownerUserId: activeOwner,
        repoFullName: 'kilo/shared-repo',
        priority: 50,
        status: 'running',
      },
    ]);
    const [queuedAttemptId] = await insertAttempts([
      { ownerUserId: blockedOwner, repoFullName: 'kilo/shared-repo', priority: 20 },
    ]);
    expect(await discoverQueuedRemediationAttempts(client.db as never, 100)).toContain(
      queuedAttemptId
    );

    const outcome = await processRemediationAttempt({
      env: { HYPERDRIVE: { connectionString } } as unknown as CloudflareEnv,
      attemptId: queuedAttemptId,
      dispatchId: 'dispatch-repo-race',
    });

    expect(outcome).toBe('skipped');
    const state = await attemptState(queuedAttemptId);
    expect(state).toMatchObject({ status: 'queued', launchAttemptCount: 0 });
    expect(Date.parse(String(state?.nextRetryAt))).toBeGreaterThan(Date.now() + 30_000);
    expect(await discoverQueuedRemediationAttempts(client.db as never, 100)).not.toContain(
      queuedAttemptId
    );
  });
});
