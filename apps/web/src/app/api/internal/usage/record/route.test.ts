// Mocks must precede the imports: `jest.mock` is hoisted above them, and
// `processUsage` resolves its PostHog client once at module scope, so the client
// has to be replaced before the route pulls that module in. Do not import `jest`
// from '@jest/globals' here — that shadows the global the transform needs.
jest.mock('@/lib/posthog', () => ({
  __esModule: true,
  default: () => ({
    capture: jest.fn(),
    isFeatureEnabled: jest.fn(),
    getFeatureFlag: jest.fn(),
    debug: jest.fn(),
    alias: jest.fn(),
  }),
  shutdownPosthog: async () => {},
}));

import { beforeEach, describe, expect, test } from '@jest/globals';
import { microdollar_usage, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { cleanupDbForTest, db } from '@/lib/drizzle';
import { defineMicrodollarUsage } from '@/tests/helpers/microdollar-usage.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';

import { POST } from './route';

// Matches INTERNAL_API_SECRET in apps/web/.env.test.
const SECRET = 'mock-secret';
const COST = 1_234;

function makeRequest(body: unknown, secret: string | null = SECRET) {
  return new NextRequest('http://localhost:3000/api/internal/usage/record', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-internal-api-key': secret }),
    },
    body: JSON.stringify(body),
  });
}

async function buildPayload(kiloUserId: string) {
  const { core, metadata } = await defineMicrodollarUsage();
  return {
    core: { ...core, kilo_user_id: kiloUserId, organization_id: null, cost: COST },
    metadata,
    // Non-zero so `isFirstUsage` short-circuits, which is the common path and the
    // one where the removed pre-check was half of all pool acquisitions.
    prior_microdollar_usage: 500,
    posthog_distinct_id: null,
  };
}

async function usedMicrodollars(userId: string) {
  const [row] = await db
    .select({ used: kilocode_users.microdollars_used })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  return row?.used ?? null;
}

describe('POST /api/internal/usage/record', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  test('rejects a request without the internal secret', async () => {
    const user = await insertTestUser();
    const response = await POST(makeRequest(await buildPayload(user.id), null));
    expect(response.status).toBe(401);
  });

  test('rejects a request with the wrong secret', async () => {
    const user = await insertTestUser();
    const response = await POST(makeRequest(await buildPayload(user.id), 'not-the-secret'));
    expect(response.status).toBe(401);
  });

  test('rejects a payload that fails the contract', async () => {
    const user = await insertTestUser();
    const payload = await buildPayload(user.id);
    // PostgreSQL timestamptz text is not strict ISO 8601 and must never be accepted.
    const response = await POST(
      makeRequest({
        ...payload,
        core: { ...payload.core, created_at: '2026-04-29 01:16:12.945+00' },
      })
    );
    expect(response.status).toBe(400);
  });

  test('records a usage row and charges the user once', async () => {
    const user = await insertTestUser();
    const payload = await buildPayload(user.id);
    const before = await usedMicrodollars(user.id);

    const response = await POST(makeRequest(payload));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'recorded',
      result: { usageId: payload.core.id, createdAt: payload.core.created_at },
    });
    const rows = await db
      .select({ id: microdollar_usage.id })
      .from(microdollar_usage)
      .where(eq(microdollar_usage.id, payload.core.id));
    expect(rows).toHaveLength(1);
    expect(await usedMicrodollars(user.id)).toBe((before ?? 0) + COST);
  });

  // The behaviour that used to come from an upfront `SELECT id FROM
  // microdollar_usage`. That lookup cost a pool connection on every request, and
  // pool acquisition is this endpoint's binding constraint, so it was removed —
  // `insertUsageRecord` recovers the identity from the primary-key conflict
  // instead. This test is what makes that removal safe.
  test('reports a redelivery as duplicate and bills it exactly once', async () => {
    const user = await insertTestUser();
    const payload = await buildPayload(user.id);

    const first = await POST(makeRequest(payload));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'recorded' });
    const usedAfterFirst = await usedMicrodollars(user.id);

    const second = await POST(makeRequest(payload));

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      status: 'duplicate',
      result: { usageId: payload.core.id, createdAt: payload.core.created_at },
    });

    // The billing invariant: the losing transaction rolls back in full.
    const rows = await db
      .select({ id: microdollar_usage.id })
      .from(microdollar_usage)
      .where(eq(microdollar_usage.id, payload.core.id));
    expect(rows).toHaveLength(1);
    expect(await usedMicrodollars(user.id)).toBe(usedAfterFirst);
  });

  test('stays idempotent across repeated redeliveries', async () => {
    const user = await insertTestUser();
    const payload = await buildPayload(user.id);

    await POST(makeRequest(payload));
    const usedAfterFirst = await usedMicrodollars(user.id);
    for (let i = 0; i < 3; i++) {
      const response = await POST(makeRequest(payload));
      expect(await response.json()).toMatchObject({ status: 'duplicate' });
    }

    const rows = await db
      .select({ id: microdollar_usage.id })
      .from(microdollar_usage)
      .where(eq(microdollar_usage.id, payload.core.id));
    expect(rows).toHaveLength(1);
    expect(await usedMicrodollars(user.id)).toBe(usedAfterFirst);
  });
});
