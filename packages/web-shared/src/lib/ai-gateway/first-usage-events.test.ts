import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import type { saveUsageRelatedDataLocally as saveUsageRelatedDataLocallyType } from './processUsage';
import type { defineMicrodollarUsage as defineMicrodollarUsageType } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import type { insertTestUser as insertTestUserType } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { findUserById as findUserByIdType } from '@kilocode/web-shared/lib/user/find-user-by-id';
import type { db as dbType } from '@kilocode/web-shared/lib/drizzle';
import {
  bouncer_usage_event_outbox,
  microdollar_usage,
  microdollar_usage_daily_repairs,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

/**
 * `processUsage` resolves its PostHog client once at module scope, so the client
 * has to be replaced before that module is loaded — hence the dynamic imports
 * below, and hence this living in its own file rather than in
 * `processUsage.test.ts`. The capture spy is created inside the factory because
 * the factory runs before this module's own top-level bindings exist.
 */
jest.mock('@kilocode/web-shared/lib/posthog', () => {
  const capture = jest.fn();
  return {
    __esModule: true,
    default: () => ({
      capture,
      isFeatureEnabled: jest.fn(),
      getFeatureFlag: jest.fn(),
      debug: jest.fn(),
      alias: jest.fn(),
    }),
    shutdownPosthog: async () => {},
    __capture: capture,
  };
});

jest.mock('@kilocode/web-shared/lib/bouncer/dispatch-usage-event-outbox', () => ({
  deliverBouncerUsageEventNow: jest.fn(async () => true),
}));
jest.mock('@kilocode/web-shared/lib/kilo-pass/usage-triggered-bonus', () => ({
  maybeIssueKiloPassBonusFromUsageThreshold: jest.fn(async () => undefined),
}));

const { deliverBouncerUsageEventNow } = jest.requireMock<{
  deliverBouncerUsageEventNow: jest.Mock<(requestId: string) => Promise<boolean>>;
}>('@kilocode/web-shared/lib/bouncer/dispatch-usage-event-outbox');
const { maybeIssueKiloPassBonusFromUsageThreshold } = jest.requireMock<{
  maybeIssueKiloPassBonusFromUsageThreshold: jest.Mock<() => Promise<void>>;
}>('@kilocode/web-shared/lib/kilo-pass/usage-triggered-bonus');

const { __capture: posthogCapture } = jest.requireMock<{
  __capture: jest.Mock<(payload: { event: string }) => void>;
}>('@kilocode/web-shared/lib/posthog');

function capturedEventCount(event: string): number {
  return posthogCapture.mock.calls.filter(([payload]) => payload?.event === event).length;
}

let saveUsageRelatedDataLocally: typeof saveUsageRelatedDataLocallyType;
let defineMicrodollarUsage: typeof defineMicrodollarUsageType;
let insertTestUser: typeof insertTestUserType;
let findUserById: typeof findUserByIdType;
let db: typeof dbType;

beforeAll(async () => {
  ({ saveUsageRelatedDataLocally } = await import('./processUsage'));
  ({ defineMicrodollarUsage } =
    await import('@kilocode/web-shared/tests/helpers/microdollar-usage.helper'));
  ({ insertTestUser } = await import('@kilocode/web-shared/tests/helpers/user.helper'));
  ({ findUserById } = await import('@kilocode/web-shared/lib/user/find-user-by-id'));
  ({ db } = await import('@kilocode/web-shared/lib/drizzle'));
});

describe('first-usage analytics for a redelivered usage write', () => {
  // `isFirstUsage` can only be answered from committed rows, so a redelivery
  // that arrives while the first delivery's transaction is still open also
  // classifies the record as the user's first usage. `recordUsageInPrimaryRegion`
  // produces exactly that: it retries after a 10s attempt timeout while the
  // write it started may still be committing. Only the delivery that inserts the
  // row may emit the events, or one user's first usage is counted twice.
  test('emits the first-usage events once for a concurrent redelivery', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    posthogCapture.mockClear();
    try {
      const user = await insertTestUser({
        id: 'test-first-usage-redelivery-user',
        microdollars_used: 0,
        google_user_email: 'first-usage-redelivery@example.com',
      });
      const { core, metadata } = await defineMicrodollarUsage();
      const usage = { ...core, kilo_user_id: user.id, cost: 800 };
      const distinctId = user.google_user_email!;

      const outcomes = await Promise.all([
        saveUsageRelatedDataLocally(usage, metadata, 0, distinctId),
        saveUsageRelatedDataLocally(usage, metadata, 0, distinctId),
      ]);

      // Both deliveries must still learn the identity of the single billed row.
      for (const outcome of outcomes) {
        expect(outcome?.usageId).toBe(usage.id);
      }
      expect(outcomes.filter(outcome => outcome?.wasRedelivery)).toHaveLength(1);
      expect(capturedEventCount('first_usage')).toBe(1);
      expect(capturedEventCount('first_microdollar_usage')).toBe(1);
      expect((await findUserById(user.id))?.microdollars_used).toBe(800);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  test('emits the first-usage events on a plain first write', async () => {
    posthogCapture.mockClear();
    const user = await insertTestUser({
      id: 'test-first-usage-single-user',
      microdollars_used: 0,
      google_user_email: 'first-usage-single@example.com',
    });
    const { core, metadata } = await defineMicrodollarUsage();
    const usage = { ...core, kilo_user_id: user.id, cost: 600 };

    const outcome = await saveUsageRelatedDataLocally(usage, metadata, 0, user.google_user_email!);

    expect(outcome).toMatchObject({ usageId: usage.id, wasRedelivery: false });
    expect(capturedEventCount('first_usage')).toBe(1);
    expect(capturedEventCount('first_microdollar_usage')).toBe(1);
  });
});

describe('post-commit side effects for a sequential redelivery', () => {
  // The queue lane can deliver a record the ingress direct lane already committed.
  // The writer must report `duplicate` for it and re-run none of the work keyed off
  // the committed insert: the debit, the daily rollup repair and Bouncer outbox rows
  // roll back with the colliding transaction, and the post-commit work never runs.
  test('reports duplicate and repeats no debit, outbox, rollup, PostHog or bonus work', async () => {
    posthogCapture.mockClear();
    deliverBouncerUsageEventNow.mockClear();
    maybeIssueKiloPassBonusFromUsageThreshold.mockClear();
    const user = await insertTestUser({
      id: 'test-redelivery-side-effects-user',
      microdollars_used: 0,
      kilo_pass_threshold: 1,
      google_user_email: 'redelivery-side-effects@example.com',
    });
    const { core, metadata } = await defineMicrodollarUsage();
    const usage = { ...core, kilo_user_id: user.id, cost: 800 };
    const distinctId = user.google_user_email!;
    const bouncerEvent = {
      request_id: 'req-redelivery-side-effects',
      payload: { requestId: 'req-redelivery-side-effects', costMicrodollars: 800 },
    };
    const countRows = async () => ({
      usage: (await db.select().from(microdollar_usage).where(eq(microdollar_usage.id, usage.id)))
        .length,
      repairs: (
        await db
          .select()
          .from(microdollar_usage_daily_repairs)
          .where(eq(microdollar_usage_daily_repairs.usage_id, usage.id))
      ).length,
      outbox: (
        await db
          .select()
          .from(bouncer_usage_event_outbox)
          .where(eq(bouncer_usage_event_outbox.request_id, bouncerEvent.request_id))
      ).length,
    });

    const first = await saveUsageRelatedDataLocally(usage, metadata, 0, distinctId, bouncerEvent);
    expect(first).toMatchObject({ usageId: usage.id, wasRedelivery: false });
    const afterFirst = {
      rows: await countRows(),
      balance: (await findUserById(user.id))?.microdollars_used,
      captures: posthogCapture.mock.calls.length,
      deliveries: deliverBouncerUsageEventNow.mock.calls.length,
      bonuses: maybeIssueKiloPassBonusFromUsageThreshold.mock.calls.length,
    };
    expect(afterFirst).toEqual({
      rows: { usage: 1, repairs: 1, outbox: 1 },
      balance: 800,
      captures: 2,
      deliveries: 1,
      bonuses: 1,
    });

    const redelivery = await saveUsageRelatedDataLocally(
      usage,
      metadata,
      0,
      distinctId,
      bouncerEvent
    );
    expect(redelivery).toEqual({
      usageId: usage.id,
      createdAt: usage.created_at,
      newMicrodollarsUsed: null,
      wasRedelivery: true,
    });
    expect({
      rows: await countRows(),
      balance: (await findUserById(user.id))?.microdollars_used,
      captures: posthogCapture.mock.calls.length,
      deliveries: deliverBouncerUsageEventNow.mock.calls.length,
      bonuses: maybeIssueKiloPassBonusFromUsageThreshold.mock.calls.length,
    }).toEqual(afterFirst);
  });
});
