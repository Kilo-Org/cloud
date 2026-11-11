import { randomUUID } from 'crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  kilocode_users,
  organizations,
  security_findings,
  security_remediation_attempts,
  security_remediations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  deferContendedRemediationAttempt,
  discoverQueuedRemediationAttempts,
} from './remediation.js';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const client = createDrizzleClient({ connectionString, ssl: false });
const fixtureUserIds = new Set<string>();
const fixtureOrganizationIds = new Set<string>();

function fixtureUserId(): string {
  const id = `security-remediation-discovery-${randomUUID()}`;
  fixtureUserIds.add(id);
  return id;
}

function fixtureOrganizationId(): string {
  const id = randomUUID();
  fixtureOrganizationIds.add(id);
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

async function insertFixtureOrganization(id: string): Promise<void> {
  await client.db.insert(organizations).values({
    id,
    name: `Security remediation discovery ${id}`,
  });
}

type OwnerSeed = { userId: string } | { organizationId: string };

type AttemptSeed = {
  id?: string;
  owner: OwnerSeed;
  repoFullName: string;
  priority: number;
  status?: 'queued' | 'launching' | 'running';
  queuedAt?: string;
  nextRetryAt?: string | null;
};

function ownerColumns(owner: OwnerSeed) {
  return 'userId' in owner
    ? { owned_by_user_id: owner.userId, owned_by_organization_id: null }
    : { owned_by_user_id: null, owned_by_organization_id: owner.organizationId };
}

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
      ...ownerColumns(seed.owner),
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
      ...ownerColumns(seed.owner),
      finding_id: findingId,
      repo_full_name: seed.repoFullName,
      status: 'queued',
    });
    attempts.push({
      id: attemptId,
      remediation_id: remediationId,
      finding_id: findingId,
      ...ownerColumns(seed.owner),
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

// The window in fixture order. Other rows in the same database must not change these expectations.
function fixtureWindow(discovered: string[], fixtureIds: string[]): string[] {
  const wanted = new Set(fixtureIds);
  return discovered.filter(id => wanted.has(id));
}

afterEach(async () => {
  for (const id of fixtureUserIds) {
    await client.db.delete(kilocode_users).where(eq(kilocode_users.id, id));
  }
  for (const id of fixtureOrganizationIds) {
    await client.db.delete(organizations).where(eq(organizations.id, id));
  }
  fixtureUserIds.clear();
  fixtureOrganizationIds.clear();
});

afterAll(async () => {
  await client.pool.end();
});

describe('remediation attempt discovery against PostgreSQL', () => {
  it('places a second owner attempt inside the window of a large due set', async () => {
    const bulkOwner = fixtureUserId();
    const policyOwner = fixtureUserId();
    await insertFixtureUser(bulkOwner);
    await insertFixtureUser(policyOwner);
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    const bulkAttemptIds = await insertAttempts(
      Array.from({ length: 150 }, (_, index) => ({
        owner: { userId: bulkOwner },
        repoFullName: `kilo/bulk-${index}`,
        priority: 20,
        queuedAt: new Date(base + index * 1000).toISOString(),
      }))
    );
    const [policyAttemptId] = await insertAttempts([
      {
        owner: { userId: policyOwner },
        repoFullName: 'kilo/policy',
        priority: 50,
        queuedAt: new Date(base + 500_000).toISOString(),
      },
    ]);

    const discovered = await discoverQueuedRemediationAttempts(client.db as never, 200);
    const window = fixtureWindow(discovered, [...bulkAttemptIds, policyAttemptId]);

    // Every fixture attempt is due, so the window holds both owners in per-owner round-robin order.
    expect(window).toEqual([bulkAttemptIds[0], policyAttemptId, ...bulkAttemptIds.slice(1)]);
  });

  it('separates user and organization owners in the same window', async () => {
    const organizationId = fixtureOrganizationId();
    const userId = fixtureUserId();
    await insertFixtureOrganization(organizationId);
    await insertFixtureUser(userId);
    const base = Date.parse('2026-04-01T00:00:00.000Z');
    const orgAttemptIds = await insertAttempts(
      Array.from({ length: 3 }, (_, index) => ({
        owner: { organizationId },
        repoFullName: `kilo/org-${index}`,
        priority: 20,
        queuedAt: new Date(base + index * 1000).toISOString(),
      }))
    );
    const userAttemptIds = await insertAttempts(
      Array.from({ length: 3 }, (_, index) => ({
        owner: { userId },
        repoFullName: `kilo/user-${index}`,
        priority: 50,
        queuedAt: new Date(base + index * 1000).toISOString(),
      }))
    );

    const discovered = await discoverQueuedRemediationAttempts(client.db as never, 20);
    const window = fixtureWindow(discovered, [...orgAttemptIds, ...userAttemptIds]);

    expect(window).toEqual([
      orgAttemptIds[0],
      userAttemptIds[0],
      orgAttemptIds[1],
      userAttemptIds[1],
      orgAttemptIds[2],
      userAttemptIds[2],
    ]);
  });

  it('orders discovery by priority and queue age within one owner', async () => {
    const userId = fixtureUserId();
    await insertFixtureUser(userId);
    const [lowPriorityFirst] = await insertAttempts([
      {
        owner: { userId },
        repoFullName: 'kilo/low-priority-earliest',
        priority: 50,
        queuedAt: '2026-03-01T00:00:00.000Z',
      },
    ]);
    const [highPriorityLater, highPriorityEarlier] = await insertAttempts([
      {
        owner: { userId },
        repoFullName: 'kilo/high-priority-later',
        priority: 0,
        queuedAt: '2026-03-03T00:00:00.000Z',
      },
      {
        owner: { userId },
        repoFullName: 'kilo/high-priority-earlier',
        priority: 0,
        queuedAt: '2026-03-02T00:00:00.000Z',
      },
    ]);

    const discovered = await discoverQueuedRemediationAttempts(client.db as never, 100);

    expect(
      fixtureWindow(discovered, [lowPriorityFirst, highPriorityLater, highPriorityEarlier])
    ).toEqual([highPriorityEarlier, highPriorityLater, lowPriorityFirst]);
  });

  it('leaves out an owner whose attempt is already launching or running', async () => {
    const busyOwner = fixtureUserId();
    const idleOwner = fixtureUserId();
    await insertFixtureUser(busyOwner);
    await insertFixtureUser(idleOwner);
    await insertAttempts([
      {
        owner: { userId: busyOwner },
        repoFullName: 'kilo/busy-running',
        priority: 50,
        status: 'running',
      },
    ]);
    const busyQueuedIds = await insertAttempts(
      Array.from({ length: 3 }, (_, index) => ({
        owner: { userId: busyOwner },
        repoFullName: `kilo/busy-queued-${index}`,
        priority: 20,
      }))
    );
    const [idleAttemptId] = await insertAttempts([
      { owner: { userId: idleOwner }, repoFullName: 'kilo/idle', priority: 50 },
    ]);

    const discovered = await discoverQueuedRemediationAttempts(client.db as never, 100);

    expect(discovered).toContain(idleAttemptId);
    for (const id of busyQueuedIds) expect(discovered).not.toContain(id);
  });

  it('defers an attempt whose owner becomes active after discovery', async () => {
    const userId = fixtureUserId();
    await insertFixtureUser(userId);
    const [queuedAttemptId] = await insertAttempts([
      { owner: { userId }, repoFullName: 'kilo/owner-race', priority: 20 },
    ]);
    expect(await discoverQueuedRemediationAttempts(client.db as never, 100)).toContain(
      queuedAttemptId
    );
    const [activeAttemptId] = await insertAttempts([
      {
        owner: { userId },
        repoFullName: 'kilo/owner-race-active',
        priority: 0,
        status: 'launching',
      },
    ]);

    await deferContendedRemediationAttempt(client.db as never, queuedAttemptId);

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

  it('defers an attempt whose repository is already active', async () => {
    const queuedOwner = fixtureOrganizationId();
    const activeOwner = fixtureUserId();
    await insertFixtureOrganization(queuedOwner);
    await insertFixtureUser(activeOwner);
    await insertAttempts([
      {
        owner: { userId: activeOwner },
        repoFullName: 'kilo/shared-repo',
        priority: 50,
        status: 'running',
      },
    ]);
    const [queuedAttemptId] = await insertAttempts([
      { owner: { organizationId: queuedOwner }, repoFullName: 'kilo/shared-repo', priority: 20 },
    ]);
    expect(await discoverQueuedRemediationAttempts(client.db as never, 100)).toContain(
      queuedAttemptId
    );

    await deferContendedRemediationAttempt(client.db as never, queuedAttemptId);

    const state = await attemptState(queuedAttemptId);
    expect(state).toMatchObject({ status: 'queued', launchAttemptCount: 0 });
    expect(Date.parse(String(state?.nextRetryAt))).toBeGreaterThan(Date.now() + 30_000);
    expect(await discoverQueuedRemediationAttempts(client.db as never, 100)).not.toContain(
      queuedAttemptId
    );
  });

  it('leaves a claimable attempt untouched', async () => {
    const userId = fixtureUserId();
    await insertFixtureUser(userId);
    const [queuedAttemptId] = await insertAttempts([
      { owner: { userId }, repoFullName: 'kilo/claimable', priority: 20 },
    ]);

    await deferContendedRemediationAttempt(client.db as never, queuedAttemptId);

    expect(await attemptState(queuedAttemptId)).toMatchObject({
      status: 'queued',
      nextRetryAt: null,
    });
  });
});
