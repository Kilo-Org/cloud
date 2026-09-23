import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { User } from '@kilocode/db/schema';

import { KiloPassPaymentProvider } from '@/lib/kilo-pass/enums';
import type { ValidatedStoreCreditPurchase } from './store-verifier';
import type * as StoreCompletion from './store-completion';

const mockProcessTopUp = jest.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);

type CreditTransactionRow = { id: string; kilo_user_id: string };

const mockLimit = jest.fn<(...args: unknown[]) => Promise<CreditTransactionRow[]>>(async () => []);
const mockWhere = jest.fn<(...args: unknown[]) => unknown>(() => ({ limit: mockLimit }));
const mockFrom = jest.fn<(...args: unknown[]) => unknown>(() => ({ where: mockWhere }));
const mockSelect = jest.fn<(...args: unknown[]) => unknown>(() => ({ from: mockFrom }));

jest.mock('@/lib/credits', () => ({
  processTopUp: (...args: unknown[]) => mockProcessTopUp(...args),
}));

jest.mock('@/lib/drizzle', () => ({
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}));

function loadCompletion(): typeof StoreCompletion {
  return jest.requireActual<typeof StoreCompletion>('./store-completion');
}

function user(overrides: Partial<User> = {}): User {
  return { id: 'user-1', ...overrides } as User;
}

function purchase(
  overrides: Partial<ValidatedStoreCreditPurchase> = {}
): ValidatedStoreCreditPurchase {
  return {
    paymentProvider: KiloPassPaymentProvider.AppStore,
    productId: 'credits.usd10.v1',
    providerTransactionId: 'tx-1',
    appAccountToken: null,
    quantity: 1,
    amountUsd: 10,
    amountMicrodollars: 10_000_000,
    purchasedAtIso: '2026-06-01T09:00:00.000Z',
    environment: 'Sandbox',
    rawPayload: {},
    ...overrides,
  };
}

describe('completeStoreCreditPurchase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessTopUp.mockResolvedValue(true);
    mockLimit.mockResolvedValue([]);
  });

  it('grants the catalog amount with the store idempotency key', async () => {
    const { completeStoreCreditPurchase } = loadCompletion();

    const result = await completeStoreCreditPurchase({
      user: user(),
      purchase: purchase({ quantity: 3, amountMicrodollars: 30_000_000 }),
    });

    expect(mockProcessTopUp).toHaveBeenCalledTimes(1);
    expect(mockProcessTopUp).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      3000,
      { type: 'stripe', stripe_payment_id: 'store-credit:app_store:tx-1' },
      expect.objectContaining({
        creditDescription: 'Credit purchase via App Store',
        skipPostTopUpFreeStuff: true,
      })
    );
    expect(result).toEqual({
      alreadyProcessed: false,
      amountUsd: 30,
      amountMicrodollars: 30_000_000,
      creditTransactionId: expect.any(String),
    });
  });

  it('describes a Google Play grant as such', async () => {
    const { completeStoreCreditPurchase } = loadCompletion();

    await completeStoreCreditPurchase({
      user: user(),
      purchase: purchase({
        paymentProvider: KiloPassPaymentProvider.GooglePlay,
        providerTransactionId: 'GPA.1234',
      }),
    });

    expect(mockProcessTopUp).toHaveBeenCalledWith(
      expect.anything(),
      1000,
      { type: 'stripe', stripe_payment_id: 'store-credit:google_play:GPA.1234' },
      expect.objectContaining({ creditDescription: 'Credit purchase via Google Play' })
    );
  });

  it('reports a replay as already processed without a second grant', async () => {
    const { completeStoreCreditPurchase } = loadCompletion();
    mockProcessTopUp.mockResolvedValueOnce(false);
    mockLimit.mockResolvedValueOnce([{ id: 'credit-1', kilo_user_id: 'user-1' }]);

    const result = await completeStoreCreditPurchase({ user: user(), purchase: purchase() });

    expect(mockProcessTopUp).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      alreadyProcessed: true,
      amountUsd: 10,
      amountMicrodollars: 10_000_000,
      creditTransactionId: 'credit-1',
    });
  });

  it('rejects a replay whose transaction belongs to another user', async () => {
    const { completeStoreCreditPurchase } = loadCompletion();
    mockProcessTopUp.mockResolvedValueOnce(false);
    mockLimit.mockResolvedValueOnce([{ id: 'credit-1', kilo_user_id: 'another-user' }]);

    await expect(
      completeStoreCreditPurchase({ user: user(), purchase: purchase() })
    ).rejects.toThrow('Store transaction already belongs to another user');
  });

  it('rejects a replay with no matching credit transaction', async () => {
    const { completeStoreCreditPurchase } = loadCompletion();
    mockProcessTopUp.mockResolvedValueOnce(false);
    mockLimit.mockResolvedValueOnce([]);

    await expect(
      completeStoreCreditPurchase({ user: user(), purchase: purchase() })
    ).rejects.toThrow('Failed to find the existing store credit transaction');
  });
});
