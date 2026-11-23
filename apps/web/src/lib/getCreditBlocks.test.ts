import type { CreditTransactionForBlocks } from '@kilocode/web-shared/lib/creditExpiration';
import {
  getCreditBlocks,
  creditGrantReasonOf,
  type CreditDeductionReason,
} from './getCreditBlocks';

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
  consumed_microdollars: opts.consumed_microdollars ?? 0,
  retired_microdollars: opts.retired_microdollars ?? 0,
  paid_credit_policy: opts.paid_credit_policy ?? null,
  credit_source: opts.credit_source ?? null,
  source_transaction_id: opts.source_transaction_id ?? null,
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

    // Equal-date and nonexpiring lots use deterministic ID order.
    expect(result.creditBlocks[0].id).toBe('t1');
    expect(result.creditBlocks[0].balance_mUsd).toBe(800);
    expect(result.creditBlocks[0].is_free).toBe(true);
    expect(result.creditBlocks[0].expiry_date).toBe('2024-01-10');

    expect(result.creditBlocks[1].id).toBe('t2');
    expect(result.creditBlocks[1].balance_mUsd).toBe(500);
    expect(result.creditBlocks[1].is_free).toBe(false);
    expect(result.creditBlocks[1].expiry_date).toBeNull();

    expect(result.creditBlocks[2].id).toBe('t3');
    expect(result.creditBlocks[2].balance_mUsd).toBe(300);
    expect(result.creditBlocks[2].is_free).toBe(true);
    expect(result.creditBlocks[2].expiry_date).toBeNull();

    expect(result.isFirstPurchase).toBe(false);
  });

  it('isFirstPurchase is true when only free transactions exist', () => {
    const transactions = [makeTransaction('t1', 0, 1000, { is_free: true })];
    const entity = makeEntity(0, 1000);

    const result = getCreditBlocks(transactions, now, entity, ENTITY_ID);

    expect(result.isFirstPurchase).toBe(true);
  });

  it('presents only unconsumed and unretired principal from normalized lots', () => {
    const transactions = [
      makeTransaction('principal', 30, 100, {
        expiry_date: '2027-01-01',
        is_free: false,
        consumed_microdollars: 30,
        retired_microdollars: 20,
        paid_credit_policy: 'one_year',
        credit_source: 'stripe',
      }),
      makeTransaction('refund', 30, -20, { expiry_date: '2027-01-01' }),
    ];
    const result = getCreditBlocks(transactions, now, makeEntity(40, 80), ENTITY_ID);
    expect(result.creditBlocks).toHaveLength(1);
    expect(result.creditBlocks[0]).toMatchObject({ id: 'principal', balance_mUsd: 40 });
  });

  it('does not show hosting settlement deposits as remaining credits or a purchase', () => {
    const transactions = [
      makeTransaction('settlement', 0, 100, {
        is_free: false,
        paid_credit_policy: 'settlement',
        retired_microdollars: 100,
      }),
    ];
    const result = getCreditBlocks(transactions, now, makeEntity(0, 0), ENTITY_ID);
    expect(result.creditBlocks).toHaveLength(0);
    expect(result.isFirstPurchase).toBe(true);
  });

  it('attaches the purchase a linked expiry closed to its deduction row', () => {
    const transactions = [
      makeTransaction('grant', 0, 1_000_000, {
        description: 'Promotional credits',
        created_at: '2023-03-03',
        expiry_date: '2024-01-10',
      }),
      makeTransaction('expiry', 0, -1_000_000, {
        description: 'Expired: Promotional credits',
        credit_category: 'credits_expired',
        original_transaction_id: 'grant',
        created_at: '2024-01-10',
      }),
    ];

    const result = getCreditBlocks(transactions, now, makeEntity(0, 0), ENTITY_ID);

    expect(result.deductions).toHaveLength(1);
    expect(result.deductions[0]).toMatchObject({
      id: 'expiry',
      amount_mUsd: -1_000_000,
      purchase: {
        id: 'grant',
        date: '2023-03-03',
        description: 'Promotional credits',
        amount_mUsd: 1_000_000,
        is_free: true,
        credit_source: null,
      },
    });
  });

  it('leaves a deduction without a linked purchase unpaired', () => {
    const transactions = [
      makeTransaction('legacy-expiry', 0, -500_000, {
        description: 'Deducting credits, due to expiration time.',
        credit_category: 'credits_expired',
        created_at: '2024-01-10',
      }),
    ];

    const result = getCreditBlocks(transactions, now, makeEntity(0, 0), ENTITY_ID);

    expect(result.deductions).toHaveLength(1);
    expect(result.deductions[0].purchase).toBeNull();
  });

  it('reports an expiry of a free program grant with its own expiry and reason', () => {
    const transactions = [
      makeTransaction('influencer-grant', 0, 1_000_000, {
        description: 'Promotional credit for influencer',
        credit_category: 'influencer',
        created_at: '2023-03-03',
        expiry_date: '2024-01-10',
      }),
      makeTransaction('expiry', 0, -1_000_000, {
        description: 'Expired: Promotional credit for influencer',
        credit_category: 'credits_expired',
        original_transaction_id: 'influencer-grant',
        created_at: '2024-01-10',
      }),
    ];

    const result = getCreditBlocks(transactions, now, makeEntity(0, 0), ENTITY_ID);

    expect(result.deductions).toHaveLength(1);
    expect(result.deductions[0]).toMatchObject({
      id: 'expiry',
      expiry: 'expired',
      purchase: { id: 'influencer-grant', is_free: true, kind: 'influencer' },
    });
  });

  it('reports a paid top-up deduction as neither an expiry nor a program grant', () => {
    const transactions = [
      makeTransaction('top-up', 0, 5_000_000, {
        description: 'Top-up via stripe',
        is_free: false,
        credit_source: 'stripe',
        expiry_date: '2027-06-20',
        created_at: '2026-06-20',
      }),
      makeTransaction('spend', 0, -1_000_000, {
        description: 'Deducting credits',
        original_transaction_id: 'top-up',
        created_at: '2026-06-21',
      }),
    ];

    const result = getCreditBlocks(transactions, now, makeEntity(1_000_000, 5_000_000), ENTITY_ID);

    expect(result.deductions).toHaveLength(1);
    expect(result.deductions[0]).toMatchObject({
      id: 'spend',
      expiry: null,
      purchase: {
        id: 'top-up',
        is_free: false,
        credit_source: 'stripe',
        kind: 'adjustment',
      },
    });
  });

  it('reports a negative row that records no category as usage', () => {
    const transactions = [
      makeTransaction('spend', 0, -1_000_000, {
        description: 'Deducting credits',
        created_at: '2024-01-10',
      }),
    ];

    const result = getCreditBlocks(transactions, now, makeEntity(1_000_000, 0), ENTITY_ID);

    expect(result.deductions[0].reason).toBe('usage');
    expect(result.deductions[0].planName).toBeNull();
  });

  it('names the coding plan a charge came from', () => {
    const transactions = [
      makeTransaction('plan-charge', 0, -20_000_000, {
        description: 'Coding plan: MiniMax Token Plan Plus',
        credit_category: 'coding-plan:minimax-token-plan-plus:req-1',
        created_at: '2024-01-10',
      }),
    ];

    const result = getCreditBlocks(transactions, now, makeEntity(20_000_000, 0), ENTITY_ID);

    expect(result.deductions[0].reason).toBe('coding_plan');
    expect(result.deductions[0].planName).toBe('MiniMax Token Plan Plus');
  });

  it('leaves a coding-plan charge whose category names no plan without a reason', () => {
    const transactions = [
      makeTransaction('plan-renewal', 0, -20_000_000, {
        description: 'Coding plan renewal: MiniMax Token Plan Plus',
        credit_category: 'coding-plan:renewal:sub-1:2026-12-01',
        created_at: '2024-01-10',
      }),
    ];

    const result = getCreditBlocks(transactions, now, makeEntity(20_000_000, 0), ENTITY_ID);

    expect(result.deductions[0].reason).toBeNull();
    expect(result.deductions[0].planName).toBeNull();
  });

  it('reports the reason each deduction category carries', () => {
    const cases: { creditCategory: string; reason: CreditDeductionReason | null }[] = [
      { creditCategory: 'store-credit-refund:app_store:txn-1', reason: 'refund_app_store' },
      { creditCategory: 'store-credit-refund:google_play:txn-2', reason: 'refund_google_play' },
      { creditCategory: 'store-credit-refund:stripe:txn-3', reason: null },
      { creditCategory: 'stripe-dispute-enforcement', reason: 'dispute' },
      { creditCategory: 'admin-cancel-kilo-pass-no-refund', reason: 'admin_cancel' },
      { creditCategory: 'manual_decrement', reason: 'admin_debit' },
      { creditCategory: 'accounting_adjustment', reason: 'correction' },
      { creditCategory: 'credits_expired', reason: null },
    ];

    for (const { creditCategory, reason } of cases) {
      const transactions = [
        makeTransaction('row', 0, -1_000_000, { credit_category: creditCategory }),
      ];

      const result = getCreditBlocks(transactions, now, makeEntity(1_000_000, 0), ENTITY_ID);

      expect(result.deductions[0].reason).toBe(reason);
      expect(result.deductions[0].planName).toBeNull();
    }
  });
});

describe('creditGrantReasonOf', () => {
  it('maps the referral grant categories to referral', () => {
    // `referral` is the admin Referral/Review grant, which carries no prefix.
    expect(creditGrantReasonOf('referral')).toBe('referral');
    expect(creditGrantReasonOf('referral-referring-bonus')).toBe('referral');
    expect(creditGrantReasonOf('referral-redeeming-bonus')).toBe('referral');
  });

  it('maps the welcome grants, including the validation grants they replaced, to welcome', () => {
    expect(creditGrantReasonOf('automatic-welcome-credits')).toBe('welcome');
    expect(creditGrantReasonOf('welcome15')).toBe('welcome');
    expect(creditGrantReasonOf('welcome20')).toBe('welcome');
    expect(creditGrantReasonOf('stytch-validation')).toBe('welcome');
    expect(creditGrantReasonOf('card-validation-no-stytch')).toBe('welcome');
    expect(creditGrantReasonOf('card-validation-upgrade')).toBe('welcome');
  });

  it('maps the Pass bonus to kilo_pass', () => {
    expect(creditGrantReasonOf('kilo-pass-bonus')).toBe('kilo_pass');
  });

  it('maps a registered member-visible promo category to promotional', () => {
    // Retail categories whose plaintext is in source; the self-service promo
    // codes are encrypted, so no test may name one of those.
    expect(creditGrantReasonOf('github-promo-2025-07-03')).toBe('promotional');
    // `obsolete` marks a grant that predates the current catalogue, not a
    // balance correction, so it still prints as credit.
    expect(creditGrantReasonOf('multiplier-promo')).toBe('promotional');
  });

  it('maps a standing program category to the reason it was earned by', () => {
    expect(creditGrantReasonOf('influencer')).toBe('influencer');
    expect(creditGrantReasonOf('usage_issue')).toBe('usage_issue');
    expect(creditGrantReasonOf('pull_request')).toBe('pull_request');
    expect(creditGrantReasonOf('vibeday')).toBe('vibe_day');
    expect(creditGrantReasonOf('feedback')).toBe('feedback');
    expect(creditGrantReasonOf('admin-bulk-grant')).toBe('admin_bulk_grant');
    expect(creditGrantReasonOf('oss-sponsorship')).toBe('oss_sponsorship');
    expect(creditGrantReasonOf('oss-monthly-reset')).toBe('oss_monthly_reset');
    expect(creditGrantReasonOf('contributor-champion-credits')).toBe('contributor_champion');
  });

  it('maps ledger accounting rows to adjustment', () => {
    expect(creditGrantReasonOf('accounting_adjustment')).toBe('adjustment');
    expect(creditGrantReasonOf('orb_migration_accounting_adjustment')).toBe('adjustment');
  });

  it('maps refund debt restorations to adjustment', () => {
    expect(creditGrantReasonOf('refund_debt_restored:2f6f7c1e-5b0a-4b8e-9c4d-1a2b3c4d5e6f')).toBe(
      'adjustment'
    );
  });

  it('maps registered balance corrections to adjustment', () => {
    expect(creditGrantReasonOf('manual_decrement')).toBe('adjustment');
    expect(creditGrantReasonOf('orb_manual_decrement')).toBe('adjustment');
    expect(creditGrantReasonOf('orb_credit_expired')).toBe('adjustment');
    expect(creditGrantReasonOf('orb_credit_voided')).toBe('adjustment');
    expect(creditGrantReasonOf('credits_expired')).toBe('adjustment');
    expect(creditGrantReasonOf('admin-cancel-refund-kilo-pass')).toBe('adjustment');
    expect(creditGrantReasonOf('admin-cancel-kilo-pass-no-refund')).toBe('adjustment');
    expect(creditGrantReasonOf('organization_custom')).toBe('adjustment');
  });

  it('maps an admin-created campaign category to promotional', () => {
    // A campaign writes `c-<slug>` built at grant time, so it is never in the
    // promo registry; it is still a member-visible signup bonus.
    expect(creditGrantReasonOf('c-summer-bonus')).toBe('promotional');
  });

  it('fails closed on an unclassified category', () => {
    // The fail-closed case: a new writer must not inflate apparent free credit.
    expect(creditGrantReasonOf('some-future-credit')).toBe('adjustment');
  });

  it('maps a missing category to adjustment', () => {
    expect(creditGrantReasonOf(null)).toBe('adjustment');
  });
});
