import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import type { saveUsageRelatedDataLocally as saveUsageRelatedDataLocallyType } from './processUsage';
import type { defineMicrodollarUsage as defineMicrodollarUsageType } from '@/tests/helpers/microdollar-usage.helper';
import type { insertTestUser as insertTestUserType } from '@/tests/helpers/user.helper';
import type { findUserById as findUserByIdType } from '@/lib/user';

/**
 * `processUsage` resolves its PostHog client once at module scope, so the client
 * has to be replaced before that module is loaded — hence the dynamic imports
 * below, and hence this living in its own file rather than in
 * `processUsage.test.ts`. The capture spy is created inside the factory because
 * the factory runs before this module's own top-level bindings exist.
 */
jest.mock('@/lib/posthog', () => {
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

const { __capture: posthogCapture } = jest.requireMock<{
  __capture: jest.Mock<(payload: { event: string }) => void>;
}>('@/lib/posthog');

function capturedEventCount(event: string): number {
  return posthogCapture.mock.calls.filter(([payload]) => payload?.event === event).length;
}

let saveUsageRelatedDataLocally: typeof saveUsageRelatedDataLocallyType;
let defineMicrodollarUsage: typeof defineMicrodollarUsageType;
let insertTestUser: typeof insertTestUserType;
let findUserById: typeof findUserByIdType;

beforeAll(async () => {
  ({ saveUsageRelatedDataLocally } = await import('./processUsage'));
  ({ defineMicrodollarUsage } = await import('@/tests/helpers/microdollar-usage.helper'));
  ({ insertTestUser } = await import('@/tests/helpers/user.helper'));
  ({ findUserById } = await import('@/lib/user'));
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
