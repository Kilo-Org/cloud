/**
 * Integration test for the expire-free-credits script.
 *
 * Prepopulates the local DB with known state, shells out to run the actual
 * script with --execute, then asserts DB state matches expectations.
 *
 * Usage:
 *   pnpm script src/scripts/d2026-03-18_expire-free-credits.test.ts
 */

import '../lib/load-env';

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { defineTestUser } from '@/tests/helpers/user.helper';

// ── Test user IDs (prefixed to avoid collisions) ────────────────────────────

const TEST_PREFIX = `expire-test-${Date.now()}`;
const USER_FULLY_SPENT = `${TEST_PREFIX}-fully-spent`;
const USER_PARTIALLY_SPENT = `${TEST_PREFIX}-partially-spent`;
const USER_UNSPENT = `${TEST_PREFIX}-unspent`;
const USER_EMPTY_DESC_CATEGORY = `${TEST_PREFIX}-empty-desc`;
const USER_NON_FREE = `${TEST_PREFIX}-non-free`;
const USER_ORG_SCOPED = `${TEST_PREFIX}-org-scoped`;
const USER_ALREADY_EXPIRING = `${TEST_PREFIX}-already-expiring`;
const USER_WRONG_DESC = `${TEST_PREFIX}-wrong-desc`;
const USER_MIXED = `${TEST_PREFIX}-mixed`;
const USER_MULTI_MATCH = `${TEST_PREFIX}-multi-match`;
const USER_ZERO_AMOUNT = `${TEST_PREFIX}-zero-amount`;
const USER_EXISTING_EXPIRATION = `${TEST_PREFIX}-existing-expiration`;
const USER_MULTI_BLOCK = `${TEST_PREFIX}-multi-block`;
const USER_BUY_USE_FREE = `${TEST_PREFIX}-buy-use-free`;
const USER_FREE_USE_BUY = `${TEST_PREFIX}-free-use-buy`;
const USER_ORB_DOUBLE_DEDUCT = `${TEST_PREFIX}-orb-double-deduct`;
const USER_ORB_EXISTING_EXPIRY = `${TEST_PREFIX}-orb-existing-expiry`;
const USER_FALSE_OVERRIDE = `${TEST_PREFIX}-false-override`;
const USER_MIXED_EXPIRY_HEADROOM = `${TEST_PREFIX}-mixed-expiry-headroom`;

const ALL_USER_IDS = [
  USER_FULLY_SPENT,
  USER_PARTIALLY_SPENT,
  USER_UNSPENT,
  USER_EMPTY_DESC_CATEGORY,
  USER_NON_FREE,
  USER_ORG_SCOPED,
  USER_ALREADY_EXPIRING,
  USER_WRONG_DESC,
  USER_MIXED,
  USER_MULTI_MATCH,
  USER_ZERO_AMOUNT,
  USER_EXISTING_EXPIRATION,
  USER_MULTI_BLOCK,
  USER_BUY_USE_FREE,
  USER_FREE_USE_BUY,
  USER_ORB_DOUBLE_DEDUCT,
  USER_ORB_EXISTING_EXPIRY,
  USER_FALSE_OVERRIDE,
  USER_MIXED_EXPIRY_HEADROOM,
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const MICRODOLLARS = 1_000_000; // $1

function makeUser(id: string, spent: number, acquired: number) {
  return defineTestUser({
    id,
    google_user_email: `${id}@test.local`,
    stripe_customer_id: `stripe-${id}`,
    microdollars_used: spent * MICRODOLLARS,
    total_microdollars_acquired: acquired * MICRODOLLARS,
  });
}

function makeCredit(
  userId: string,
  amount: number,
  opts: {
    category?: string;
    description?: string | null;
    isFree?: boolean;
    expiryDate?: string | null;
    organizationId?: string | null;
    originalBaseline?: number;
  } = {}
) {
  return {
    kilo_user_id: userId,
    amount_microdollars: amount * MICRODOLLARS,
    is_free: opts.isFree ?? true,
    credit_category: opts.category ?? 'automatic-welcome-credits',
    description:
      opts.description ??
      'Free credits for new users, obtained by stych approval, card validation, or maybe some other method',
    expiry_date: opts.expiryDate ?? null,
    organization_id: opts.organizationId ?? null,
    original_baseline_microdollars_used: (opts.originalBaseline ?? 0) * MICRODOLLARS,
    check_category_uniqueness: false,
  };
}

const EXPECTED_LOCAL_DB_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

function assertLocalDatabase() {
  const dbUrl = process.env.POSTGRES_SCRIPT_URL ?? process.env.POSTGRES_URL ?? '';
  if (dbUrl !== EXPECTED_LOCAL_DB_URL) {
    console.error(`ABORT: Expected local database URL but got: ${dbUrl}`);
    console.error(`Expected: ${EXPECTED_LOCAL_DB_URL}`);
    process.exit(1);
  }
}

let testCsvPath = '';

function generateTestCsv(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'expire-test-'));
  const csvPath = path.join(dir, 'input.csv');

  const csvContent = [
    'CREDIT_CATEGORY,SHOULD_EXPIRE,DESCRIPTION,RECORDS,USERS,BLOCKED_USERS,FIRST_ISSUED_AT,LAST_ISSUED_AT,AMOUNT_GRANTED_USD,PCT,EXPIRE_IN_DAYS,REVIEWED_BY',
    'automatic-welcome-credits,TRUE,"Free credits for new users, obtained by stych approval, card validation, or maybe some other method",0,0,0,,,,,30,test',
    'referral-redeeming-bonus,TRUE,,0,0,0,,,,,30,test',
    'card-validation-upgrade,TRUE,Upgrade credits for passing card validation after having already passed Stytch validation.,0,0,0,,,,,30,test',
    'card-validation-no-stytch,TRUE,Free credits for passing card validation without prior Stytch validation.,0,0,0,,,,,30,test',
    'stytch-validation,TRUE,Free credits for passing Stytch fraud detection.,0,0,0,,,,,30,test',
    'referral-redeeming-bonus,FALSE,Specific desc marked false in CSV,0,0,0,,,,,30,test',
    'custom,TRUE,long-expiry-test,0,0,0,,,,,180,test',
  ].join('\n');

  writeFileSync(csvPath, csvContent);
  return csvPath;
}

let insertedCreditIds: string[] = [];

async function setup() {
  testCsvPath = generateTestCsv();
  console.log(`  Generated test CSV: ${testCsvPath}\n`);

  console.log('Setting up test data...\n');

  const EARLIER_EXPIRY = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

  // Insert users
  await db.insert(kilocode_users).values([
    makeUser(USER_FULLY_SPENT, 10, 10),
    makeUser(USER_PARTIALLY_SPENT, 5, 10),
    makeUser(USER_UNSPENT, 0, 10),
    makeUser(USER_EMPTY_DESC_CATEGORY, 3, 10),
    makeUser(USER_NON_FREE, 5, 10),
    makeUser(USER_ORG_SCOPED, 5, 10),
    makeUser(USER_ALREADY_EXPIRING, 5, 10),
    makeUser(USER_WRONG_DESC, 5, 10),
    makeUser(USER_MIXED, 5, 20),
    makeUser(USER_MULTI_MATCH, 5, 20),
    makeUser(USER_ZERO_AMOUNT, 5, 5),
    {
      ...makeUser(USER_EXISTING_EXPIRATION, 5, 10),
      next_credit_expiration_at: EARLIER_EXPIRY,
    },
    makeUser(USER_MULTI_BLOCK, 7, 15),
    // Both have $10 used, $20 acquired ($10 paid + $10 free), balance = $10
    makeUser(USER_BUY_USE_FREE, 10, 20),
    makeUser(USER_FREE_USE_BUY, 10, 20),
    // Orb double-deduction: user got $5 free, spent it all via Orb (which reduced
    // total_acquired by $5), balance is now $0. Without the floor-at-zero fix,
    // expiring the $5 credit would push balance to -$5.
    makeUser(USER_ORB_DOUBLE_DEDUCT, 0, 0),
    // Orb double-deduction with existing expiring credit: user got $5 free (already
    // has expiry from a previous run) + $5 new free credit. Orb adjusted -$5.
    // acquired=5, used=0, balance=$5. Existing $5 expires fully → $0.
    // New $5 should NOT push to -$5.
    {
      ...makeUser(USER_ORB_EXISTING_EXPIRY, 0, 5),
      next_credit_expiration_at: EARLIER_EXPIRY,
    },
    // Specific FALSE overrides catch-all TRUE: referral-redeeming-bonus has a
    // catch-all TRUE row, but the specific description below is marked FALSE.
    makeUser(USER_FALSE_OVERRIDE, 0, 10),
    // Mixed expiry headroom: Orb clawed back spend, so balance=$5 but has $10 in
    // free credits. Two $5 credits with different EXPIRE_IN_DAYS. Both would fully
    // expire ($5 each), but only $5 headroom. The earlier-expiring (30d) should be
    // preferred. acquired=$5, used=$0, balance=$5.
    makeUser(USER_MIXED_EXPIRY_HEADROOM, 0, 5),
  ]);

  // Insert credits
  const credits = await db
    .insert(credit_transactions)
    .values([
      // 1. Fully spent user: $10 matching promo, $10 spent → nothing should expire
      makeCredit(USER_FULLY_SPENT, 10),

      // 2. Partially spent user: $10 matching promo, $5 spent → $5 would expire
      makeCredit(USER_PARTIALLY_SPENT, 10),

      // 3. Unspent user: $10 matching promo, $0 spent → $10 would expire
      makeCredit(USER_UNSPENT, 10),

      // 4. Empty-desc category (referral): should match any description
      makeCredit(USER_EMPTY_DESC_CATEGORY, 10, {
        category: 'referral-redeeming-bonus',
        description: 'Referral bonus for redeeming code some-uuid-here',
      }),

      // 5. Non-free credit: should NOT be touched (is_free=false)
      makeCredit(USER_NON_FREE, 10, { isFree: false }),

      // 6. Org-scoped credit: should NOT be touched
      makeCredit(USER_ORG_SCOPED, 10, {
        organizationId: '00000000-0000-0000-0000-000000000001',
      }),

      // 7. Already-expiring credit: should NOT be touched (already has expiry_date)
      makeCredit(USER_ALREADY_EXPIRING, 10, {
        expiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      }),

      // 8. Wrong description: right category, wrong description → NOT touched
      makeCredit(USER_WRONG_DESC, 10, {
        category: 'automatic-welcome-credits',
        description: 'Something completely different',
      }),

      // 9. Mixed credits: one matching + one non-matching on same user
      makeCredit(USER_MIXED, 10), // matching
      makeCredit(USER_MIXED, 10, {
        category: 'some-unrelated-category',
        description: 'Not in the spreadsheet',
      }), // non-matching

      // 10. Multiple matching credits on same user
      makeCredit(USER_MULTI_MATCH, 10), // matching
      makeCredit(USER_MULTI_MATCH, 10, {
        category: 'card-validation-upgrade',
        description:
          'Upgrade credits for passing card validation after having already passed Stytch validation.',
      }), // also matching

      // 11. Zero-amount credit: $0 matching → should still get expiry set
      makeCredit(USER_ZERO_AMOUNT, 0),

      // 12. User with existing next_credit_expiration_at (10 days out) + matching credit
      //     LEAST should preserve the earlier (10-day) date
      makeCredit(USER_EXISTING_EXPIRATION, 10),

      // 13. Multiple free credit blocks: 3 x $5, user spent $7
      //     All 3 should get expiry. At expiration: first fully used ($0 expires),
      //     second partially used ($3 expires), third unused ($5 expires) = $8 total
      makeCredit(USER_MULTI_BLOCK, 5),
      makeCredit(USER_MULTI_BLOCK, 5, {
        category: 'card-validation-no-stytch',
        description: 'Free credits for passing card validation without prior Stytch validation.',
      }),
      makeCredit(USER_MULTI_BLOCK, 5, {
        category: 'stytch-validation',
        description: 'Free credits for passing Stytch fraud detection.',
      }),

      // 14. Buy $10, use $10, get $10 free → original_baseline=10 (spent $10 before free credit)
      //     The paid $10 is non-expiring, non-free
      makeCredit(USER_BUY_USE_FREE, 10, { isFree: false }),
      makeCredit(USER_BUY_USE_FREE, 10, { originalBaseline: 10 }),

      // 15. Get $10 free, use $10, buy $10 → original_baseline=0 (spent $0 before free credit)
      makeCredit(USER_FREE_USE_BUY, 10),
      makeCredit(USER_FREE_USE_BUY, 10, { isFree: false }),

      // 16. Orb double-deduction: $5 free credit, Orb already clawed back (balance=0)
      makeCredit(USER_ORB_DOUBLE_DEDUCT, 5, {
        category: 'stytch-validation',
        description: 'Free credits for passing Stytch fraud detection.',
      }),

      // 17. Orb double-deduction with existing expiry:
      //     $5 free credit already has expiry (simulates previous script run)
      makeCredit(USER_ORB_EXISTING_EXPIRY, 5, {
        category: 'stytch-validation',
        description: 'Free credits for passing Stytch fraud detection.',
        expiryDate: EARLIER_EXPIRY,
      }),
      //     $5 new free credit (no expiry yet, will be tagged by this script)
      makeCredit(USER_ORB_EXISTING_EXPIRY, 5),

      // 18. Specific FALSE overrides catch-all TRUE:
      //     referral-redeeming-bonus has a catch-all TRUE row in the CSV,
      //     but this specific description is marked FALSE → should NOT be expired.
      makeCredit(USER_FALSE_OVERRIDE, 10, {
        category: 'referral-redeeming-bonus',
        description: 'Specific desc marked false in CSV',
      }),

      // 19. Mixed expiry headroom: two $5 credits, only one fits within $5 headroom.
      //     The 30-day credit (automatic-welcome-credits) should be expired.
      //     The 180-day credit (custom/long-expiry-test) should be skipped.
      makeCredit(USER_MIXED_EXPIRY_HEADROOM, 5, {
        category: 'custom',
        description: 'long-expiry-test',
      }),
      makeCredit(USER_MIXED_EXPIRY_HEADROOM, 5),
    ])
    .returning({ id: credit_transactions.id });

  insertedCreditIds = credits.map(c => c.id);
  console.log(`  Inserted ${ALL_USER_IDS.length} users and ${insertedCreditIds.length} credits\n`);
}

async function cleanup() {
  console.log('\nCleaning up test data...');
  await db
    .delete(credit_transactions)
    .where(inArray(credit_transactions.kilo_user_id, ALL_USER_IDS));
  await db.delete(kilocode_users).where(inArray(kilocode_users.id, ALL_USER_IDS));
  if (testCsvPath) {
    try {
      unlinkSync(testCsvPath);
    } catch {
      // ignore — temp file cleanup is best-effort
    }
  }
  console.log('  Done.\n');
}

// ── Assertions ──────────────────────────────────────────────────────────────

type AssertionResult = { name: string; passed: boolean; detail?: string };

async function runAssertions(): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  // Fetch all credits for our test users
  const allCredits = await db
    .select()
    .from(credit_transactions)
    .where(inArray(credit_transactions.kilo_user_id, ALL_USER_IDS));

  const creditsFor = (userId: string) => allCredits.filter(c => c.kilo_user_id === userId);

  // Fetch all users
  const allUsers = await db
    .select()
    .from(kilocode_users)
    .where(inArray(kilocode_users.id, ALL_USER_IDS));

  const userById = (id: string) => allUsers.find(u => u.id === id)!;

  // --- 1. Fully spent user: expiry_date should be set
  {
    const credits = creditsFor(USER_FULLY_SPENT).filter(c => c.expiry_date != null);
    results.push({
      name: 'Fully spent user: expiry_date set',
      passed: credits.length === 1,
      detail: `Expected 1 credit with expiry_date, got ${credits.length}`,
    });
  }

  // --- 2. Fully spent user: next_credit_expiration_at set
  {
    const user = userById(USER_FULLY_SPENT);
    results.push({
      name: 'Fully spent user: next_credit_expiration_at set',
      passed: user.next_credit_expiration_at != null,
      detail: `Got ${user.next_credit_expiration_at}`,
    });
  }

  // --- 3. Partially spent user: expiry_date set
  {
    const credits = creditsFor(USER_PARTIALLY_SPENT).filter(c => c.expiry_date != null);
    results.push({
      name: 'Partially spent user: expiry_date set',
      passed: credits.length === 1,
      detail: `Expected 1 credit with expiry_date, got ${credits.length}`,
    });
  }

  // --- 4. Partially spent user: expiration_baseline set from original
  {
    const credit = creditsFor(USER_PARTIALLY_SPENT).find(c => c.expiry_date != null);
    results.push({
      name: 'Partially spent user: expiration_baseline set to 0',
      passed: credit?.expiration_baseline_microdollars_used === 0,
      detail: `Got ${credit?.expiration_baseline_microdollars_used}`,
    });
  }

  // --- 5. Unspent user: expiry_date set
  {
    const credits = creditsFor(USER_UNSPENT).filter(c => c.expiry_date != null);
    results.push({
      name: 'Unspent user: expiry_date set',
      passed: credits.length === 1,
      detail: `Expected 1 credit with expiry_date, got ${credits.length}`,
    });
  }

  // --- 6. Empty-desc category (referral): expiry_date set
  {
    const credits = creditsFor(USER_EMPTY_DESC_CATEGORY).filter(c => c.expiry_date != null);
    results.push({
      name: 'Referral (any-description match): expiry_date set',
      passed: credits.length === 1,
      detail: `Expected 1 credit with expiry_date, got ${credits.length}`,
    });
  }

  // --- 7. Non-free credit: NOT touched
  {
    const credits = creditsFor(USER_NON_FREE).filter(c => c.expiry_date != null);
    results.push({
      name: 'Non-free credit: NOT touched',
      passed: credits.length === 0,
      detail: `Expected 0 credits with expiry_date, got ${credits.length}`,
    });
  }

  // --- 8. Org-scoped credit: NOT touched
  {
    const credits = creditsFor(USER_ORG_SCOPED);
    const untouched = credits.every(c => c.expiry_date == null);
    results.push({
      name: 'Org-scoped credit: NOT touched',
      passed: untouched,
      detail: `Credits: ${credits.map(c => ({ id: c.id, expiry: c.expiry_date }))}`,
    });
  }

  // --- 9. Already-expiring credit: NOT modified
  {
    const credit = creditsFor(USER_ALREADY_EXPIRING).find(c => c.expiry_date != null);
    const originalExpiry = new Date(credit!.expiry_date!).getTime();
    // Should still be ~60 days out, not 30
    const fiftyDaysFromNow = Date.now() + 50 * 24 * 60 * 60 * 1000;
    results.push({
      name: 'Already-expiring credit: original expiry preserved',
      passed: originalExpiry > fiftyDaysFromNow,
      detail: `Expiry: ${credit?.expiry_date}`,
    });
  }

  // --- 10. Expiry date is ~30 days from now
  {
    const credit = creditsFor(USER_PARTIALLY_SPENT).find(c => c.expiry_date != null);
    if (credit?.expiry_date) {
      const expiryMs = new Date(credit.expiry_date).getTime();
      const expectedMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
      const diffHours = Math.abs(expiryMs - expectedMs) / (1000 * 60 * 60);
      results.push({
        name: 'Expiry date is ~30 days from now',
        passed: diffHours < 24, // within 24 hours tolerance
        detail: `Diff: ${diffHours.toFixed(1)} hours from expected`,
      });
    } else {
      results.push({
        name: 'Expiry date is ~30 days from now',
        passed: false,
        detail: 'No credit with expiry found',
      });
    }
  }

  // --- 11. Wrong description: NOT touched
  {
    const credits = creditsFor(USER_WRONG_DESC).filter(c => c.expiry_date != null);
    results.push({
      name: 'Wrong description: NOT touched',
      passed: credits.length === 0,
      detail: `Expected 0 credits with expiry_date, got ${credits.length}`,
    });
  }

  // --- 12. Mixed credits: only matching one gets expiry
  {
    const credits = creditsFor(USER_MIXED);
    const withExpiry = credits.filter(c => c.expiry_date != null);
    const withoutExpiry = credits.filter(c => c.expiry_date == null);
    results.push({
      name: 'Mixed credits: only matching credit gets expiry',
      passed: withExpiry.length === 1 && withoutExpiry.length === 1,
      detail: `Expected 1 with expiry + 1 without, got ${withExpiry.length} + ${withoutExpiry.length}`,
    });
  }

  // --- 13. Mixed credits: the non-matching one is untouched
  {
    const credits = creditsFor(USER_MIXED);
    const nonMatching = credits.find(c => c.credit_category === 'some-unrelated-category');
    results.push({
      name: 'Mixed credits: non-matching credit untouched',
      passed: nonMatching?.expiry_date == null,
      detail: `Non-matching credit expiry: ${nonMatching?.expiry_date}`,
    });
  }

  // --- 14. Multiple matching credits: both get expiry
  {
    const credits = creditsFor(USER_MULTI_MATCH).filter(c => c.expiry_date != null);
    results.push({
      name: 'Multiple matching credits: both get expiry',
      passed: credits.length === 2,
      detail: `Expected 2 credits with expiry_date, got ${credits.length}`,
    });
  }

  // --- 15. Zero-amount credit: expiry set
  {
    const credits = creditsFor(USER_ZERO_AMOUNT).filter(c => c.expiry_date != null);
    results.push({
      name: 'Zero-amount credit: expiry set',
      passed: credits.length === 1,
      detail: `Expected 1 credit with expiry_date, got ${credits.length}`,
    });
  }

  // --- 16. Existing next_credit_expiration_at: LEAST preserves earlier date
  {
    const user = userById(USER_EXISTING_EXPIRATION);
    if (user.next_credit_expiration_at) {
      const expiryMs = new Date(user.next_credit_expiration_at).getTime();
      // Should be ~10 days out (the earlier one), not ~30 days
      const twentyDaysFromNow = Date.now() + 20 * 24 * 60 * 60 * 1000;
      results.push({
        name: 'Existing expiration: LEAST preserves earlier date',
        passed: expiryMs < twentyDaysFromNow,
        detail: `next_credit_expiration_at: ${user.next_credit_expiration_at}`,
      });
    } else {
      results.push({
        name: 'Existing expiration: LEAST preserves earlier date',
        passed: false,
        detail: 'next_credit_expiration_at is null',
      });
    }
  }

  // --- 17. Multi-block: all 3 credits get expiry set
  {
    const credits = creditsFor(USER_MULTI_BLOCK).filter(c => c.expiry_date != null);
    results.push({
      name: 'Multi-block: all 3 credits get expiry set',
      passed: credits.length === 3,
      detail: `Expected 3 credits with expiry_date, got ${credits.length}`,
    });
  }

  // --- 18. Multi-block: all baselines set to 0 (from original_baseline)
  {
    const credits = creditsFor(USER_MULTI_BLOCK).filter(c => c.expiry_date != null);
    const allBaselinesZero = credits.every(c => c.expiration_baseline_microdollars_used === 0);
    results.push({
      name: 'Multi-block: all baselines set to 0',
      passed: allBaselinesZero,
      detail: `Baselines: ${credits.map(c => c.expiration_baseline_microdollars_used)}`,
    });
  }

  // --- Helper: simulate expiration and return total expired amount
  const { computeExpiration } = await import('@/lib/creditExpiration');

  function simulateExpiration(userId: string): number {
    const credits = creditsFor(userId).filter(c => c.expiry_date != null);
    const user = userById(userId);
    if (credits.length === 0) return 0;

    const expiringTxns = credits.map(c => ({
      id: c.id,
      amount_microdollars: c.amount_microdollars,
      expiration_baseline_microdollars_used: c.expiration_baseline_microdollars_used,
      expiry_date: c.expiry_date,
      description: c.description,
      is_free: c.is_free,
    }));

    const expiryDate = new Date(credits[0].expiry_date!);
    const { newTransactions } = computeExpiration(
      expiringTxns,
      { id: user.id, microdollars_used: user.microdollars_used },
      expiryDate,
      user.id
    );

    return newTransactions.reduce((sum, t) => sum + Math.abs(t.amount_microdollars ?? 0), 0);
  }

  // --- 19. Multi-block: verify projected expiration
  //     User has 3 x $5 = $15, spent $7 → $8 should expire
  {
    const totalExpired = simulateExpiration(USER_MULTI_BLOCK);
    const expectedExpired = 8 * MICRODOLLARS;
    results.push({
      name: 'Multi-block: projected expiration is $8 (3x$5 - $7 spent)',
      passed: totalExpired === expectedExpired,
      detail: `Expected ${expectedExpired}, got ${totalExpired}`,
    });
  }

  // --- 20. Buy $10, use $10, get $10 free → balance $10 today, $0 after expiry
  //     Free credit has original_baseline=10 (user already spent $10 when it was granted)
  //     So the free $10 is NOT covered by usage → all $10 expires
  {
    const user = userById(USER_BUY_USE_FREE);
    const balanceNow = user.total_microdollars_acquired - user.microdollars_used;
    const totalExpired = simulateExpiration(USER_BUY_USE_FREE);
    const balanceAfter = balanceNow - totalExpired;

    results.push({
      name: 'Buy-use-free: balance is $10 today',
      passed: balanceNow === 10 * MICRODOLLARS,
      detail: `Expected ${10 * MICRODOLLARS}, got ${balanceNow}`,
    });
    results.push({
      name: 'Buy-use-free: $10 expires (free credit unused)',
      passed: totalExpired === 10 * MICRODOLLARS,
      detail: `Expected ${10 * MICRODOLLARS}, got ${totalExpired}`,
    });
    results.push({
      name: 'Buy-use-free: balance is $0 after expiry',
      passed: balanceAfter === 0,
      detail: `Expected 0, got ${balanceAfter}`,
    });
  }

  // --- 21. Get $10 free, use $10, buy $10 → balance $10 today, $10 after expiry
  //     Free credit has original_baseline=0 (user had $0 spent when it was granted)
  //     So the free $10 IS fully covered by usage → $0 expires
  {
    const user = userById(USER_FREE_USE_BUY);
    const balanceNow = user.total_microdollars_acquired - user.microdollars_used;
    const totalExpired = simulateExpiration(USER_FREE_USE_BUY);
    const balanceAfter = balanceNow - totalExpired;

    results.push({
      name: 'Free-use-buy: balance is $10 today',
      passed: balanceNow === 10 * MICRODOLLARS,
      detail: `Expected ${10 * MICRODOLLARS}, got ${balanceNow}`,
    });
    results.push({
      name: 'Free-use-buy: $0 expires (free credit fully used)',
      passed: totalExpired === 0,
      detail: `Expected 0, got ${totalExpired}`,
    });
    results.push({
      name: 'Free-use-buy: balance is $10 after expiry',
      passed: balanceAfter === 10 * MICRODOLLARS,
      detail: `Expected ${10 * MICRODOLLARS}, got ${balanceAfter}`,
    });
  }

  // --- 22. Orb double-deduction: credit skipped, balance stays at $0
  //     User got $5 free, Orb clawed it back (acquired=0, used=0, balance=$0).
  //     Without the fix, expiring the $5 credit would push to -$5.
  //     With the fix, expiry is NOT set on the credit (skipped).
  {
    const user = userById(USER_ORB_DOUBLE_DEDUCT);
    const balanceNow = user.total_microdollars_acquired - user.microdollars_used;

    results.push({
      name: 'Orb double-deduct: balance is $0 today',
      passed: balanceNow === 0,
      detail: `Expected 0, got ${balanceNow}`,
    });
    // Credit should NOT have expiry_date set (skipped to prevent negative balance)
    const credit = creditsFor(USER_ORB_DOUBLE_DEDUCT).find(
      c => c.credit_category === 'stytch-validation'
    );
    results.push({
      name: 'Orb double-deduct: credit skipped (no expiry set)',
      passed: credit?.expiry_date == null,
      detail: `expiry_date: ${credit?.expiry_date}`,
    });
  }

  // --- 23. Orb double-deduction with existing expiring credit:
  //     User has $5 balance. Existing $5 credit (with expiry) already covers it.
  //     New $5 credit should NOT get expiry — would push to -$5.
  {
    const user = userById(USER_ORB_EXISTING_EXPIRY);
    const balanceNow = user.total_microdollars_acquired - user.microdollars_used;

    results.push({
      name: 'Orb existing-expiry: balance is $5 today',
      passed: balanceNow === 5 * MICRODOLLARS,
      detail: `Expected ${5 * MICRODOLLARS}, got ${balanceNow}`,
    });
    // The new credit (automatic-welcome-credits) should NOT have expiry set
    const newCredit = creditsFor(USER_ORB_EXISTING_EXPIRY).find(
      c => c.credit_category === 'automatic-welcome-credits'
    );
    results.push({
      name: 'Orb existing-expiry: new credit skipped (no expiry set)',
      passed: newCredit?.expiry_date == null,
      detail: `expiry_date: ${newCredit?.expiry_date}`,
    });
  }

  // --- 24. Specific FALSE overrides catch-all TRUE:
  //     referral-redeeming-bonus has catch-all TRUE, but the specific description
  //     is marked FALSE → credit should NOT have expiry_date set.
  {
    const credits = creditsFor(USER_FALSE_OVERRIDE).filter(c => c.expiry_date != null);
    results.push({
      name: 'Specific FALSE overrides catch-all TRUE: NOT touched',
      passed: credits.length === 0,
      detail: `Expected 0 credits with expiry_date, got ${credits.length}`,
    });
  }

  // --- 25. Mixed expiry headroom: two $5 credits with different EXPIRE_IN_DAYS,
  //     only $5 headroom. The earlier-expiring credit (30d, automatic-welcome-credits)
  //     should be expired; the later-expiring one (180d, custom/long-expiry-test)
  //     should be skipped.
  {
    const credits = creditsFor(USER_MIXED_EXPIRY_HEADROOM);
    const earlyExpiry = credits.find(c => c.credit_category === 'automatic-welcome-credits');
    const lateExpiry = credits.find(c => c.credit_category === 'custom');
    results.push({
      name: 'Mixed expiry headroom: earlier-expiring credit gets expiry',
      passed: earlyExpiry?.expiry_date != null,
      detail: `expiry_date: ${earlyExpiry?.expiry_date}`,
    });
    results.push({
      name: 'Mixed expiry headroom: later-expiring credit skipped',
      passed: lateExpiry?.expiry_date == null,
      detail: `expiry_date: ${lateExpiry?.expiry_date}`,
    });
  }

  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    assertLocalDatabase();
    await setup();

    console.log('Running expire-free-credits script with --execute...\n');
    const output = execSync(
      `pnpm script src/scripts/d2026-03-18_expire-free-credits.ts --input=${testCsvPath} --execute --yes --batch-size=1`,
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: { ...process.env },
        timeout: 120_000,
      }
    );
    console.log(output);

    console.log('Running assertions...\n');
    const results = await runAssertions();

    let passed = 0;
    let failed = 0;
    for (const r of results) {
      const icon = r.passed ? 'PASS' : 'FAIL';
      console.log(`  [${icon}] ${r.name}`);
      if (!r.passed) {
        console.log(`         ${r.detail}`);
        failed++;
      } else {
        passed++;
      }
    }

    console.log(`\n${passed} passed, ${failed} failed out of ${results.length} assertions`);

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await cleanup();
    await closeAllDrizzleConnections();
  }
}

void main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
