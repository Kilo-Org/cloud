import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  admitCreditPurchaseIntent,
  consentToReplaceMalformedCreditPurchaseIntent,
  MalformedCreditPurchaseIntentError,
  resetCreditPurchaseIntentForTests,
  restoreCreditPurchaseIntent,
} from './credit-purchase-intent';

const SCOPE = 'credit-purchase';
const KEY = 'unresolved';
const APPLE_PRODUCT_ID = 'credits.usd10.v1';
const APP_ACCOUNT_TOKEN = '550e8400-e29b-41d4-a716-446655440000';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn<(scope: string, key: string) => Promise<string | null>>(),
    setItem: vi.fn<(scope: string, key: string, value: string) => Promise<void>>(),
    removeItemIfValue: vi.fn<(scope: string, key: string, value: string) => Promise<boolean>>(),
  };
});

vi.mock('@/lib/persist/encrypted-kv', () => storage);
vi.mock('expo-crypto', () => {
  let sequence = 0;
  return {
    randomUUID: () => {
      sequence += 1;
      return `intent-${String(sequence)}`;
    },
  };
});
vi.mock('./use-store-credit-purchase', () => ({
  getPurchaseCompletionId: () => 'tx-1',
}));

function intentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'intent-1',
    productId: APPLE_PRODUCT_ID,
    accountToken: APP_ACCOUNT_TOKEN,
    transactionIds: [],
    dispatched: true,
    ...overrides,
  };
}

function stored(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(intentRecord(overrides));
}

async function captureRestoreError(): Promise<unknown> {
  try {
    await restoreCreditPurchaseIntent();
    return null;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  resetCreditPurchaseIntentForTests();
  storage.values.clear();
  storage.getItem.mockReset();
  storage.setItem.mockReset();
  storage.removeItemIfValue.mockReset();
  storage.getItem.mockImplementation(async (_scope, key) => {
    await Promise.resolve();
    return storage.values.get(key) ?? null;
  });
  storage.setItem.mockImplementation(async (_scope, key, value) => {
    await Promise.resolve();
    storage.values.set(key, value);
  });
  storage.removeItemIfValue.mockImplementation(async (_scope, key, value) => {
    await Promise.resolve();
    if (storage.values.get(key) !== value) {
      return false;
    }
    storage.values.delete(key);
    return true;
  });
});

describe('restoreCreditPurchaseIntent retries', () => {
  it('retries after one read rejection without losing the stored record', async () => {
    const saved = stored({ transactionIds: ['tx-1'] });
    storage.values.set(KEY, saved);
    storage.getItem.mockRejectedValueOnce(new Error('database is locked'));

    await expect(restoreCreditPurchaseIntent()).rejects.toThrow('database is locked');
    expect(storage.values.get(KEY)).toBe(saved);

    await expect(restoreCreditPurchaseIntent()).resolves.toMatchObject({
      id: 'intent-1',
      productId: APPLE_PRODUCT_ID,
      transactionIds: ['tx-1'],
      dispatched: true,
    });
    expect(storage.getItem).toHaveBeenCalledTimes(2);
    expect(storage.values.get(KEY)).toBe(saved);
  });

  it('retries the migration write after one write rejection', async () => {
    const legacy = JSON.stringify({
      productId: APPLE_PRODUCT_ID,
      accountToken: APP_ACCOUNT_TOKEN,
      transactionIds: [],
      dispatched: true,
    });
    storage.values.set(KEY, legacy);
    storage.setItem.mockRejectedValueOnce(new Error('disk full'));

    await expect(restoreCreditPurchaseIntent()).rejects.toThrow('disk full');
    expect(storage.values.get(KEY)).toBe(legacy);

    await expect(restoreCreditPurchaseIntent()).resolves.toMatchObject({
      productId: APPLE_PRODUCT_ID,
      dispatched: true,
    });
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(storage.values.get(KEY)).toMatch(/"id":"intent-\d+"/);
  });

  it('keeps a never-dispatched reservation when its retirement write rejects', async () => {
    const saved = stored({ dispatched: false });
    storage.values.set(KEY, saved);
    storage.removeItemIfValue.mockRejectedValueOnce(new Error('database is locked'));

    await expect(restoreCreditPurchaseIntent()).rejects.toThrow('database is locked');
    expect(storage.values.get(KEY)).toBe(saved);

    await expect(restoreCreditPurchaseIntent()).resolves.toBeNull();
    expect(storage.values.has(KEY)).toBe(false);
  });

  it('retires a restored reservation that was never dispatched', async () => {
    const saved = stored({ dispatched: false });
    storage.values.set(KEY, saved);

    await expect(restoreCreditPurchaseIntent()).resolves.toBeNull();
    expect(storage.removeItemIfValue).toHaveBeenCalledWith(SCOPE, KEY, saved);
    expect(storage.values.has(KEY)).toBe(false);
  });
});

describe('malformed stored intent', () => {
  it('fails closed with a distinct error when the stored text is not JSON', async () => {
    const raw = '{"productId":';
    storage.values.set(KEY, raw);

    const firstError = await captureRestoreError();
    expect(firstError).toBeInstanceOf(MalformedCreditPurchaseIntentError);
    expect(firstError).not.toHaveProperty('cause');
    expect(firstError instanceof Error ? firstError.message : '').not.toContain('productId');

    await expect(restoreCreditPurchaseIntent()).rejects.toBeInstanceOf(
      MalformedCreditPurchaseIntentError
    );
    expect(storage.values.get(KEY)).toBe(raw);
    expect(storage.removeItemIfValue).not.toHaveBeenCalled();
  });

  it('fails closed with a distinct error when JSON does not match the schema', async () => {
    const raw = JSON.stringify({ productId: 42, accountToken: null, transactionIds: 'tx-1' });
    storage.values.set(KEY, raw);

    await expect(restoreCreditPurchaseIntent()).rejects.toBeInstanceOf(
      MalformedCreditPurchaseIntentError
    );
    await expect(restoreCreditPurchaseIntent()).rejects.toBeInstanceOf(
      MalformedCreditPurchaseIntentError
    );
    expect(storage.values.get(KEY)).toBe(raw);
    expect(storage.removeItemIfValue).not.toHaveBeenCalled();
  });
});

describe('consentToReplaceMalformedCreditPurchaseIntent', () => {
  it('removes only the captured raw value and then permits a new admission', async () => {
    const raw = '{"productId":';
    storage.values.set(KEY, raw);
    await expect(restoreCreditPurchaseIntent()).rejects.toBeInstanceOf(
      MalformedCreditPurchaseIntentError
    );

    await expect(consentToReplaceMalformedCreditPurchaseIntent()).resolves.toBe(true);
    expect(storage.removeItemIfValue).toHaveBeenCalledWith(SCOPE, KEY, raw);
    expect(storage.values.has(KEY)).toBe(false);

    await expect(restoreCreditPurchaseIntent()).resolves.toBeNull();
    const admitted = await admitCreditPurchaseIntent(APPLE_PRODUCT_ID, APP_ACCOUNT_TOKEN);
    expect(admitted.created).toBe(true);
    expect(admitted.intent).toMatchObject({
      productId: APPLE_PRODUCT_ID,
      accountToken: APP_ACCOUNT_TOKEN,
      transactionIds: [],
      dispatched: false,
    });
    expect(storage.values.has(KEY)).toBe(true);
  });

  it('refuses to erase raw data that changed after the malformed read', async () => {
    storage.values.set(KEY, '{"productId":');
    await expect(restoreCreditPurchaseIntent()).rejects.toBeInstanceOf(
      MalformedCreditPurchaseIntentError
    );

    const replacement = stored({ id: 'intent-9' });
    storage.values.set(KEY, replacement);

    await expect(consentToReplaceMalformedCreditPurchaseIntent()).resolves.toBe(false);
    expect(storage.values.get(KEY)).toBe(replacement);

    await expect(restoreCreditPurchaseIntent()).resolves.toMatchObject({ id: 'intent-9' });
  });

  it('treats a captured value that is already absent as removed', async () => {
    storage.values.set(KEY, '{"productId":');
    await expect(restoreCreditPurchaseIntent()).rejects.toBeInstanceOf(
      MalformedCreditPurchaseIntentError
    );
    storage.values.delete(KEY);

    await expect(consentToReplaceMalformedCreditPurchaseIntent()).resolves.toBe(true);
    await expect(restoreCreditPurchaseIntent()).resolves.toBeNull();
  });

  it('reports nothing to replace when no malformed value was captured', async () => {
    storage.values.set(KEY, stored());

    await expect(consentToReplaceMalformedCreditPurchaseIntent()).resolves.toBe(false);
    expect(storage.removeItemIfValue).not.toHaveBeenCalled();
    expect(storage.values.has(KEY)).toBe(true);
  });
});
