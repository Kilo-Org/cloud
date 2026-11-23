// Must run before any billing module loads its Stripe configuration.
import './benchmark-billing-test-env';
import { describe, it, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import {
  kilocode_users,
  organization_memberships,
  organization_user_limits,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { benchmarkProjectId } from '@kilocode/auto-routing-contracts';

import type * as Admission from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';

let resolveBenchmarkCaller: typeof Admission.resolveBenchmarkCaller;
let readGatewayBalance: typeof Admission.readGatewayBalance;
let canSpendPaidUsage: (balance: number) => boolean;

const ROUTER_ID = '6f1c2f3a-1111-4a2b-8c3d-4e5f60718293';

beforeAll(async () => {
  jest.resetModules();
  ({ resolveBenchmarkCaller, readGatewayBalance } =
    await import('@kilocode/web-shared/lib/ai-gateway/gateway-admission'));
  ({ canSpendPaidUsage } = await import('@kilocode/worker-utils/account-access'));
});

/** The signed-in caller the admission path returns, narrowed once so tests read real fields. */
function signedInCaller(caller: Awaited<ReturnType<typeof Admission.resolveBenchmarkCaller>>) {
  if (caller.kind !== 'signed-in')
    throw new Error(`expected a signed-in caller, got ${caller.kind}`);
  return caller;
}

function orgAssignment(input: {
  organizationId: string;
  actorUserId: string;
  executorUserId: string;
}) {
  return {
    engineIdentity: 'engine',
    runId: 'run',
    model: 'openai/gpt-4o',
    variant: '',
    caseId: 'case',
    repetition: 0,
    generation: 1,
    startedAt: Date.now(),
    api: 'chat/completions' as const,
    modelRequestId: '11111111-1111-4111-8111-111111111111',
    assignmentId: '22222222-2222-4222-8222-222222222222',
    requestId: '33333333-3333-4333-8333-333333333333',
    usageId: '44444444-4444-4444-8444-444444444444',
    payer: { type: 'organization' as const, id: input.organizationId },
    actorUserId: input.actorUserId,
    executorUserId: input.executorUserId,
    platformOrganizationId: null,
    projectId: benchmarkProjectId({ scope: 'org', slug: 'pool', routerId: ROUTER_ID }),
  };
}

/**
 * R45: the signed funding actor must still be a billable organization member at admission
 * time. When the membership is revoked, or a member allowance is exhausted, the call must not
 * be admitted on the organization and must never fall back to the actor's personal account.
 */
describe('R45 organization membership and allowance at admission', () => {
  let ownerId: string;
  let organizationId: string;

  beforeEach(async () => {
    const owner = await insertTestUser({
      google_user_email: `org-owner-${crypto.randomUUID()}@example.com`,
      microdollars_used: 0,
      total_microdollars_acquired: 5_000_000,
    });
    ownerId = owner.id;
    const organization = await createTestOrganization(
      `bench-r45-${crypto.randomUUID()}`,
      ownerId,
      10_000_000
    );
    organizationId = organization.id;
  });

  it('admits the funding actor while the membership is current', async () => {
    const caller = await resolveBenchmarkCaller(
      orgAssignment({ organizationId, actorUserId: ownerId, executorUserId: ownerId }) as never
    );
    const signedIn = signedInCaller(caller);
    expect(signedIn.organizationId).toBe(organizationId);
    const account = await readGatewayBalance(signedIn.user, organizationId, 'openai/gpt-4o', {
      noAutoTopUp: true,
      fresh: true,
    });
    expect(account.balance).toBeGreaterThan(0);
    expect(canSpendPaidUsage(account.balance)).toBe(true);
  });

  it('refuses the organization and never bills the personal account once membership is revoked', async () => {
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, ownerId));

    const caller = await resolveBenchmarkCaller(
      orgAssignment({ organizationId, actorUserId: ownerId, executorUserId: ownerId }) as never
    );
    // The signed org identity still resolves to the same organization: no personal fallback.
    const signedIn = signedInCaller(caller);
    expect(signedIn.organizationId).toBe(organizationId);
    expect(signedIn.user.id).toBe(ownerId);

    // The organization membership lookup now yields no balance, so admission refuses.
    const account = await readGatewayBalance(signedIn.user, organizationId, 'openai/gpt-4o', {
      noAutoTopUp: true,
      fresh: true,
    });
    expect(account.balance).toBe(0);
    expect(canSpendPaidUsage(account.balance)).toBe(false);

    // The actor's own funded account was never consulted, and was never debited.
    const personal = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, ownerId),
    });
    expect(personal?.microdollars_used).toBe(0);
  });

  it('refuses once the member allowance is exhausted while the organization still has balance', async () => {
    // Non-seat organizations honour per-member limits; a seat-based one ignores them by design.
    await db
      .update(organizations)
      .set({ require_seats: false })
      .where(eq(organizations.id, organizationId));
    await db.insert(organization_user_limits).values({
      organization_id: organizationId,
      kilo_user_id: ownerId,
      limit_type: 'daily',
      microdollar_limit: 0,
    });

    const caller = await resolveBenchmarkCaller(
      orgAssignment({ organizationId, actorUserId: ownerId, executorUserId: ownerId }) as never
    );
    const account = await readGatewayBalance(
      signedInCaller(caller).user,
      organizationId,
      'openai/gpt-4o',
      { noAutoTopUp: true, fresh: true }
    );
    expect(canSpendPaidUsage(account.balance)).toBe(false);
    expect(account.balanceLimitedByUserAllowance).toBe(true);
  });
});

/**
 * R48: the "fresh balance" requirement is not an absolute reservation. A prior native write
 * moves the account's spend coordinate, and the next admission must read that committed state
 * from the primary and refuse — it must not admit on a pre-debit snapshot.
 */
describe('R48 a prior native debit is visible to the next admission', () => {
  it('refuses after the account crosses zero through an ordinary native write', async () => {
    const user = await insertTestUser({
      google_user_email: `bench-r48-${crypto.randomUUID()}@example.com`,
      microdollars_used: 0,
      total_microdollars_acquired: 1_000_000,
    });

    const before = await readGatewayBalance(user, undefined, 'openai/gpt-4o', {
      noAutoTopUp: true,
      fresh: true,
    });
    expect(canSpendPaidUsage(before.balance)).toBe(true);

    // What the native usage writer commits when an ordinary request spends the account.
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 1_000_000 })
      .where(eq(kilocode_users.id, user.id));

    const refreshed = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    const after = await readGatewayBalance(refreshed!, undefined, 'openai/gpt-4o', {
      noAutoTopUp: true,
      fresh: true,
    });
    expect(after.balance).toBeLessThanOrEqual(0);
    expect(canSpendPaidUsage(after.balance)).toBe(false);
  });
});
