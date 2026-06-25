import type { CreditTransactionForBlocks } from '@/lib/creditExpiration';
import { getCreditBlocks } from './getCreditBlocks';

const makeTransaction = (
  id: string,
  expiration_baseline_microdollars_used: number,
  amount: number,
  opts: Partial<CreditTransactionForBlocks> = {}
): CreditTransactionForBlocks => ({
  id,
  amount_microdollars: amount,
  expiration_baseline_microdollars_used,
  expiry_date: opts.expiry_date ?? null,
  description: opts.description ?? 'Test credits',
  is_free: opts.is_free ?? true,
  credit_category: opts.credit_category ?? null,
  original_transaction_id: opts.original_transaction_id ?? null,
  created_at: opts.created_at ?? '2024-01-01',
});

const ENTITY_ID = 'user-1';

const makeEntity = (microdollars_used: number, total_microdollars_acquired: number) => ({
  id: ENTITY_ID,
  microdollars_used,
  total_microdollars_acquired,
});

describe('getCreditBlocks', () => {
  const now = new Date('2024-01-15');

  it('returns empty blocks when no transactions', () => {
    const entity = makeEntity(0, 0);
    const result = getCreditBlocks([], now, entity, ENTITY_ID);

    expect(result.creditBlocks).toHaveLength(0);
    expect(result.totalBalance_mUsd).toBe(0);
    expect(result.isFirstPurchase).toBe(true);
  });

  it('returns non-expiring transaction as credit block', () => {
    const transactions = [makeTransaction('t1', 0, 1000, { is_free: false })];
    const entity = makeEntity(0, 1000);

    const result = getCreditBlocks(transactions, now, entity, ENTITY_ID);

    expect(result.creditBlocks).toHaveLength(1);
    expect(result.creditBlocks[0].balance_mUsd).toBe(1000);
    expect(result.isFirstPurchase).toBe(false);
  });

  it('excludes already-expired transactions by original_transaction_id', () => {
    const transactions = [
      makeTransaction('t1', 0, 1000, { expiry_date: '2024-01-10' }),
      makeTransaction('expired-t1', 0, -1000, {
        credit_category: 'credits_expired',
        original_transaction_id: 't1',
      }),
    ];
    const entity = makeEntity(0, 0);

    const result = getCreditBlocks(transactions, now, entity, ENTITY_ID);

    // t1 should be excluded since it has a matching expiration record
    expect(result.creditBlocks).toHaveLength(0);
  });

  it('excludes already-expired transactions by orb_credit_block_id', () => {
    const transactions = [
      makeTransaction('t1', 0, 1000, { expiry_date: '2024-01-10' }),
      makeTransaction('expired-t1', 0, -1000, {
        credit_category: 'orb_credit_expired',
        original_transaction_id: 't1',
      }),
    ];
    const entity = makeEntity(0, 0);

    const result = getCreditBlocks(transactions, now, entity, ENTITY_ID);

    expect(result.creditBlocks).toHaveLength(0);
  });

  it('computes partial expiration balance correctly', () => {
    const transactions = [makeTransaction('t1', 0, 1000, { expiry_date: '2024-01-10' })];
    const entity = makeEntity(400, 1000);

    const result = getCreditBlocks(transactions, now, entity, ENTITY_ID);

    expect(result.creditBlocks).toHaveLength(1);
    // User got 1000, used 400, so 600 remaining
    expect(result.creditBlocks[0].balance_mUsd).toBe(600);
  });

  it('handles multiple partial expirations with different dates', () => {
    const transactions = [
      makeTransaction('t1', 0, 1000, { expiry_date: '2024-01-10', created_at: '2024-01-01' }),
      makeTransaction('t2', 1000, 500, { expiry_date: '2024-01-12', created_at: '2024-01-02' }),
    ];
    // User used 600 total, t1 claims 600 usage, t2 claims 0 usage
    const entity = makeEntity(600, 1500);

    const result = getCreditBlocks(transactions, now, entity, ENTITY_ID);

    expect(result.creditBlocks).toHaveLength(2);
    // Blocks ordered by expiry date (earliest first)
    // t1: 1000 original, 600 used, 400 remaining
    expect(result.creditBlocks[0].id).toBe('t1');
    expect(result.creditBlocks[0].balance_mUsd).toBe(400);
    // t2: 500 original, 0 used (baseline=1000 > user's 600 usage), 500 remaining
    expect(result.creditBlocks[1].id).toBe('t2');
    expect(result.creditBlocks[1].balance_mUsd).toBe(500);
  });

  it('handles tricky case with out of order expiration', () => {
    const transactions = [
      makeTransaction('t1', 500, 1000, { expiry_date: '2024-01-10', created_at: '2024-01-03' }),
      makeTransaction('t2', 300, 2000, { expiry_date: '2024-01-12', created_at: '2024-01-02' }),
      makeTransaction('t3', 0, 1000, { created_at: '2024-01-01' }),
      makeTransaction('t4', 100, 100, { expiry_date: '2024-01-11', created_at: '2024-01-01' }),
    ];
    // User used 600 total, acquired 4100
    // t4: baseline=100, claims usage [100,200] = 100 used, 0 remaining
    const entity = makeEntity(600, 4100);
    const result = getCreditBlocks(transactions, now, entity, ENTITY_ID);

    expect(result.creditBlocks).toHaveLength(3);
    expect(result.totalBalance_mUsd).toBe(3500); // 4100 - 600

    // Expiring blocks ordered by expiry date (earliest first)
    // t1: baseline=500, claims usage [500,600) = 100 used, 900 remaining
    expect(result.creditBlocks[0].id).toBe('t1');
    expect(result.creditBlocks[0].balance_mUsd).toBe(900);

    // t2: baseline=300, claims usage [300,500) because [500,600) is already claimed by t1 = 200 used, 1800 remaining
    expect(result.creditBlocks[1].id).toBe('t2');
    expect(result.creditBlocks[1].balance_mUsd).toBe(1800);

    //no t4 because it has 0 balance i.e. is fully expired, but would have claimed [100,200)

    // t3: non-expiring, gets remaining balance, i.e. [0,100) and [200,300) = 200 used, 800 left
    expect(result.creditBlocks[2].id).toBe('t3');
    expect(result.creditBlocks[2].balance_mUsd).toBe(800);
    expect(result.creditBlocks[2].expiry_date).toBeNull();
  });

  it('mixes expiring and non-expiring transactions', () => {
    const transactions = [
      makeTransaction('t1', 0, 1000, { expiry_date: '2024-01-10', is_free: true }),
      makeTransaction('t2', 0, 500, { is_free: false, created_at: '2024-01-02' }),
      makeTransaction('t3', 0, 300, { is_free: true, created_at: '2024-01-01' }),
    ];
    const entity = makeEntity(200, 1800);

    const result = getCreditBlocks(transactions, now, entity, ENTITY_ID);

    expect(result.creditBlocks).toHaveLength(3);
    expect(result.totalBalance_mUsd).toBe(1600); // 1800 - 200

    // Expiring block first (t1), then non-expiring ordered by created_at (oldest first)
    // t1: 1000 original, 200 used, 800 remaining
    expect(result.creditBlocks[0].id).toBe('t1');
    expect(result.creditBlocks[0].balance_mUsd).toBe(800);
    expect(result.creditBlocks[0].is_free).toBe(true);
    expect(result.creditBlocks[0].expiry_date).toBe('2024-01-10');

    // Non-expiring blocks: t3 (oldest) then t2 (newer)
    // t3: 300 original, non-expiring
    expect(result.creditBlocks[1].id).toBe('t3');
    expect(result.creditBlocks[1].balance_mUsd).toBe(300);
    expect(result.creditBlocks[1].is_free).toBe(true);
    expect(result.creditBlocks[1].expiry_date).toBeNull();

    // t2: 500 original, non-expiring
    expect(result.creditBlocks[2].id).toBe('t2');
    expect(result.creditBlocks[2].balance_mUsd).toBe(500);
    expect(result.creditBlocks[2].is_free).toBe(false);
    expect(result.creditBlocks[2].expiry_date).toBeNull();

    expect(result.isFirstPurchase).toBe(false);
  });

  it('isFirstPurchase is true when only free transactions exist', () => {
    const transactions = [makeTransaction('t1', 0, 1000, { is_free: true })];
    const entity = makeEntity(0, 1000);

    const result = getCreditBlocks(transactions, now, entity, ENTITY_ID);

    expect(result.isFirstPurchase).toBe(true);
  });
});
