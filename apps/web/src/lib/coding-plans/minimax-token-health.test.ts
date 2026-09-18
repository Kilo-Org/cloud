jest.mock('@/lib/ai-gateway/byok/encryption', () => ({
  decryptApiKey: jest.fn(() => 'plaintext-api-key'),
}));

jest.mock('@/lib/utils.server', () => ({
  sentryLogger: jest.fn(() => jest.fn()),
}));

const mockOrderBy = jest.fn<Promise<unknown[]>, []>();
jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        leftJoin: jest.fn(() => ({
          where: jest.fn(() => ({
            orderBy: mockOrderBy,
          })),
        })),
      })),
    })),
  },
}));

import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { sentryLogger } from '@/lib/utils.server';

import type { AdminSlackNotification } from '@/lib/slack/admin-notifications';
import {
  buildMiniMaxTokenHealthSlackNotification,
  checkAllMiniMaxTokenHealth,
  getMiniMaxTokenHealthTargets,
  needsImmediateFollowUp,
  probeMiniMaxTokenPlanRemains,
  sendMiniMaxTokenHealthSlackSummary,
  type MiniMaxTokenHealthEntry,
  type MiniMaxTokenHealthTarget,
} from './minimax-token-health';

// sentryLogger('minimax-token-health', 'info') runs once when
// minimax-token-health.ts loads (see `logBadResponse`). Module loading
// finishes before any test lifecycle hook runs, so by `beforeAll` the mocked
// sentryLogger's first call result is the logger instance under test.
let mockLogBadResponse: jest.Mock;

function target(overrides: Partial<MiniMaxTokenHealthTarget> = {}): MiniMaxTokenHealthTarget {
  return {
    inventoryId: 'inv-1',
    planId: 'minimax-token-plan-plus',
    upstreamPlanId: '522927812420526084',
    encryptedApiKey: { iv: 'iv', data: 'data', authTag: 'tag' },
    subscriptionId: 'sub-1',
    userId: 'user-1',
    subscriptionStatus: 'active',
    ...overrides,
  };
}

function entry(overrides: Partial<MiniMaxTokenHealthEntry> = {}): MiniMaxTokenHealthEntry {
  return {
    inventoryId: 'inv-1',
    planId: 'minimax-token-plan-plus',
    upstreamPlanId: '522927812420526084',
    subscriptionId: 'sub-1',
    userId: 'user-1',
    subscriptionStatus: 'active',
    category: 'healthy',
    reason: 'ok',
    ...overrides,
  };
}

beforeAll(() => {
  mockLogBadResponse = jest.mocked(sentryLogger).mock.results[0]!.value as jest.Mock;
});

afterEach(() => {
  jest.restoreAllMocks();
  mockLogBadResponse.mockClear();
});

describe('probeMiniMaxTokenPlanRemains', () => {
  it.each([
    [401, 'denied'],
    [403, 'denied'],
    [408, 'unreachable'],
    [429, 'unreachable'],
    [500, 'unreachable'],
    [503, 'unreachable'],
    [400, 'bad_response'],
    [404, 'bad_response'],
    [422, 'bad_response'],
  ] as const)(
    'classifies HTTP %s as %s instead of always mapping to denied',
    async (status, expectedCategory) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response('upstream body', { status }));

      const result = await probeMiniMaxTokenPlanRemains('api-key');

      expect(result).toEqual({
        category: expectedCategory,
        reason: `http_${status}`,
        httpStatus: status,
      });
    }
  );
});

describe('getMiniMaxTokenHealthTargets', () => {
  it('keeps the most recently created live subscription when a key has more than one', async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        inventoryId: 'inv-1',
        planId: 'minimax-token-plan-plus',
        upstreamPlanId: '522927812420526084',
        encryptedApiKey: null,
        subscriptionId: 'sub-old',
        userId: 'user-old',
        subscriptionStatus: 'active',
        subscriptionCreatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        inventoryId: 'inv-1',
        planId: 'minimax-token-plan-plus',
        upstreamPlanId: '522927812420526084',
        encryptedApiKey: null,
        subscriptionId: 'sub-new',
        userId: 'user-new',
        subscriptionStatus: 'past_due',
        subscriptionCreatedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        inventoryId: 'inv-2',
        planId: 'minimax-token-plan-plus',
        upstreamPlanId: '522937595127087110',
        encryptedApiKey: null,
        subscriptionId: 'sub-2',
        userId: 'user-2',
        subscriptionStatus: 'active',
        subscriptionCreatedAt: '2026-01-15T00:00:00.000Z',
      },
    ]);

    const targets = await getMiniMaxTokenHealthTargets();

    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ inventoryId: 'inv-1', subscriptionId: 'sub-new' });
    expect(targets[0]).not.toHaveProperty('subscriptionCreatedAt');
    expect(targets[1]).toMatchObject({ inventoryId: 'inv-2', subscriptionId: 'sub-2' });
  });
});

describe('needsImmediateFollowUp', () => {
  it('flags non-healthy categories only for active or past_due subscriptions', () => {
    expect(
      needsImmediateFollowUp(entry({ category: 'denied', subscriptionStatus: 'active' }))
    ).toBe(true);
    expect(
      needsImmediateFollowUp(entry({ category: 'bad_response', subscriptionStatus: 'past_due' }))
    ).toBe(true);
    expect(
      needsImmediateFollowUp(entry({ category: 'denied', subscriptionStatus: 'canceled' }))
    ).toBe(false);
    expect(needsImmediateFollowUp(entry({ category: 'denied', subscriptionStatus: null }))).toBe(
      false
    );
    expect(
      needsImmediateFollowUp(entry({ category: 'healthy', subscriptionStatus: 'active' }))
    ).toBe(false);
  });
});

describe('checkAllMiniMaxTokenHealth', () => {
  it('probes each target with the decrypted key and reports totals-relevant fields', async () => {
    const getTargets = jest.fn(async () => [
      target({ inventoryId: 'inv-1' }),
      target({ inventoryId: 'inv-2', encryptedApiKey: null, subscriptionStatus: 'past_due' }),
    ]);
    const probe = jest.fn(async (_apiKey: string) => ({
      category: 'healthy' as const,
      reason: 'ok',
    }));

    const results = await checkAllMiniMaxTokenHealth({ getTargets, probe });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ inventoryId: 'inv-1', category: 'healthy', reason: 'ok' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('plaintext-api-key');
    expect(results[1]).toMatchObject({
      inventoryId: 'inv-2',
      category: 'configuration',
      reason: 'missing_api_key',
    });
  });

  it('reports a configuration failure when decryption throws', async () => {
    const encryption = jest.requireMock<{ decryptApiKey: jest.Mock }>(
      '@/lib/ai-gateway/byok/encryption'
    );
    encryption.decryptApiKey.mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    const getTargets = jest.fn(async () => [target()]);
    const probe = jest.fn(async (_apiKey: string) => ({
      category: 'healthy' as const,
      reason: 'ok',
    }));

    const results = await checkAllMiniMaxTokenHealth({ getTargets, probe });

    expect(results).toEqual([
      expect.objectContaining({ category: 'configuration', reason: 'decryption_failed' }),
    ]);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('buildMiniMaxTokenHealthSlackNotification', () => {
  it('summarizes totals and reports no follow-up needed when everything is healthy', () => {
    const result = buildMiniMaxTokenHealthSlackNotification(
      [entry({ inventoryId: 'inv-1' }), entry({ inventoryId: 'inv-2' })],
      new Date('2026-09-17T12:00:00.000Z')
    );

    expect(result.totals).toEqual({
      checked: 2,
      healthy: 2,
      badResponse: 0,
      denied: 0,
      unreachable: 0,
      configuration: 0,
      needsFollowUp: 0,
    });
    expect(result.notification.text).toContain('`2` checked');
    expect(result.notification.text).toContain('`0` active subscriptions need follow-up');
    expect(JSON.stringify(result.notification.blocks)).toContain(
      'No active subscriptions need follow-up.'
    );
  });

  it('lists active subscriptions that need immediate follow-up', () => {
    const result = buildMiniMaxTokenHealthSlackNotification([
      entry({ inventoryId: 'inv-1', category: 'healthy', reason: 'ok' }),
      entry({
        inventoryId: 'inv-2',
        subscriptionId: 'sub-2',
        upstreamPlanId: '522937595127087110',
        userId: 'user-2',
        category: 'bad_response',
        reason: 'provider_plan_inactive',
        subscriptionStatus: 'active',
      }),
      entry({
        inventoryId: 'inv-3',
        subscriptionId: 'sub-3',
        upstreamPlanId: '522937971515547655',
        userId: 'user-3',
        category: 'denied',
        reason: 'http_429',
        httpStatus: 429,
        subscriptionStatus: 'past_due',
      }),
      // Not counted: no live subscription attached to this key.
      entry({
        inventoryId: 'inv-4',
        subscriptionId: null,
        category: 'denied',
        reason: 'http_429',
        subscriptionStatus: null,
      }),
    ]);

    expect(result.totals).toMatchObject({ checked: 4, needsFollowUp: 2 });
    const rendered = JSON.stringify(result.notification.blocks);
    expect(rendered).toContain('522937595127087110');
    expect(rendered).toContain('provider_plan_inactive');
    expect(rendered).toContain('user-2');
    expect(rendered).toContain('522937971515547655');
    expect(rendered).toContain('http_429 (HTTP 429)');
    expect(rendered).toContain('user-3');
    expect(rendered).not.toContain('inv-4');
    expect(result.notification.text).toContain('`2` active subscriptions need follow-up');
  });

  it('truncates the follow-up list and reports the omitted count', () => {
    const entries = Array.from({ length: 45 }, (_, index) =>
      entry({
        inventoryId: `inv-${index}`,
        subscriptionId: `sub-${index}`,
        upstreamPlanId: `plan-${index}`,
        category: 'denied',
        reason: 'http_429',
      })
    );

    const result = buildMiniMaxTokenHealthSlackNotification(entries);

    expect(result.totals.needsFollowUp).toBe(45);
    const rendered = JSON.stringify(result.notification.blocks);
    expect(rendered).toContain('5 additional entries not shown.');
  });
});

describe('sendMiniMaxTokenHealthSlackSummary', () => {
  it('runs the sweep and sends the generated notification', async () => {
    const checkAll = jest.fn(async () => [entry()]);
    const sendNotification = jest.fn(async (_notification: AdminSlackNotification) => undefined);

    await expect(
      sendMiniMaxTokenHealthSlackSummary({ checkAll, sendNotification })
    ).resolves.toMatchObject({ checked: 1, healthy: 1 });

    expect(checkAll).toHaveBeenCalledWith();
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('`1` checked') })
    );
  });

  it('logs full detail for each bad_response entry and skips other categories', async () => {
    const checkAll = jest.fn(async () => [
      entry({ inventoryId: 'inv-1', category: 'healthy', reason: 'ok' }),
      entry({
        inventoryId: 'inv-2',
        planId: 'minimax-token-plan-plus',
        upstreamPlanId: '522935352948625416',
        subscriptionId: 'sub-2',
        userId: 'user-2',
        subscriptionStatus: 'active',
        category: 'bad_response',
        reason: 'invalid_response',
      }),
      entry({
        inventoryId: 'inv-3',
        category: 'denied',
        reason: 'http_401',
        httpStatus: 401,
      }),
    ]);
    const sendNotification = jest.fn(async (_notification: AdminSlackNotification) => undefined);

    await sendMiniMaxTokenHealthSlackSummary({ checkAll, sendNotification });

    expect(mockLogBadResponse).toHaveBeenCalledTimes(1);
    expect(mockLogBadResponse).toHaveBeenCalledWith('MiniMax token health bad_response', {
      inventoryId: 'inv-2',
      planId: 'minimax-token-plan-plus',
      upstreamPlanId: '522935352948625416',
      subscriptionId: 'sub-2',
      userId: 'user-2',
      subscriptionStatus: 'active',
      reason: 'invalid_response',
      httpStatus: undefined,
    });
  });
});
