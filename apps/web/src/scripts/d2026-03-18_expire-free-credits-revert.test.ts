/**
 * Integration test for the expire-free-credits revert script.
 *
 * 1. Inserts test users + credits
 * 2. Runs the expire script with --execute (produces a mutations file)
 * 3. Runs the revert script with --execute using that mutations file
 * 4. Asserts DB state is back to the original state
 *
 * Usage:
 *   pnpm script src/scripts/d2026-03-18_expire-free-credits-revert.test.ts
 */

import '../lib/load-env';

import { execSync } from 'node:child_process';
import { readdirSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';
import { defineTestUser } from '@/tests/helpers/user.helper';

// ── Test user IDs ────────────────────────────────────────────────────────────

const TEST_PREFIX = `revert-test-${Date.now()}`;
const USER_PARTIALLY_SPENT = `${TEST_PREFIX}-partially-spent`;
const USER_UNSPENT = `${TEST_PREFIX}-unspent`;
const USER_FULLY_SPENT = `${TEST_PREFIX}-fully-spent`;
const USER_EXISTING_EXPIRY = `${TEST_PREFIX}-existing-expiry`;

const ALL_USER_IDS = [USER_PARTIALLY_SPENT, USER_UNSPENT, USER_FULLY_SPENT, USER_EXISTING_EXPIRY];

// ── Helpers ──────────────────────────────────────────────────────────────────

const MICRODOLLARS = 1_000_000;

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
    expiryDate?: string | null;
  } = {}
) {
  return {
    kilo_user_id: userId,
    amount_microdollars: amount * MICRODOLLARS,
    is_free: true,
    credit_category: opts.category ?? 'automatic-welcome-credits',
    description:
      opts.description ??
      'Free credits for new users, obtained by stych approval, card validation, or maybe some other method',
    expiry_date: opts.expiryDate ?? null,
    organization_id: null,
    original_baseline_microdollars_used: 0,
    check_category_uniqueness: false,
  };
}

type Snapshot = {
  credits: Map<string, { expiry_date: string | null; expiration_baseline: number | null }>;
  users: Map<string, { next_credit_expiration_at: string | null }>;
};

async function takeSnapshot(): Promise<Snapshot> {
  const credits = await db
    .select()
    .from(credit_transactions)
    .where(inArray(credit_transactions.kilo_user_id, ALL_USER_IDS));

  const users = await db
    .select()
    .from(kilocode_users)
    .where(inArray(kilocode_users.id, ALL_USER_IDS));

  return {
    credits: new Map(
      credits.map(c => [
        c.id,
        {
          expiry_date: c.expiry_date,
          expiration_baseline: c.expiration_baseline_microdollars_used,
        },
      ])
    ),
    users: new Map(
      users.map(u => [u.id, { next_credit_expiration_at: u.next_credit_expiration_at }])
    ),
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

  await db.insert(kilocode_users).values([
    makeUser(USER_PARTIALLY_SPENT, 5, 10),
    makeUser(USER_UNSPENT, 0, 10),
    makeUser(USER_FULLY_SPENT, 10, 10),
    {
      ...makeUser(USER_EXISTING_EXPIRY, 5, 15),
      next_credit_expiration_at: EARLIER_EXPIRY,
    },
  ]);

  const credits = await db
    .insert(credit_transactions)
    .values([
      // Partially spent: $10 credit, $5 spent → $5 would expire
      makeCredit(USER_PARTIALLY_SPENT, 10),

      // Unspent: $10 credit, $0 spent → $10 would expire
      makeCredit(USER_UNSPENT, 10),

      // Fully spent: $10 credit, $10 spent → $0 would expire
      makeCredit(USER_FULLY_SPENT, 10),

      // Existing expiry user: has an independent expiring credit + a new one
      makeCredit(USER_EXISTING_EXPIRY, 5, { expiryDate: EARLIER_EXPIRY }),
      makeCredit(USER_EXISTING_EXPIRY, 10),
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

function findLatestMutationsFile(): string {
  const outputDir = path.join(__dirname, 'output');
  const files = readdirSync(outputDir)
    .filter(f => f.includes('.mutations.jsonl'))
    .sort();
  if (files.length === 0) throw new Error('No mutations file found');
  return path.join(outputDir, files[files.length - 1]);
}

type AssertionResult = { name: string; passed: boolean; detail?: string };

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    assertLocalDatabase();
    await setup();

    // 1. Take snapshot of original state
    const before = await takeSnapshot();

    // 2. Run the expire script
    console.log('Running expire-free-credits script with --execute...\n');
    const expireOutput = execSync(
      `pnpm script src/scripts/d2026-03-18_expire-free-credits.ts --input=${testCsvPath} --execute --yes --batch-size=1`,
      { cwd: process.cwd(), encoding: 'utf-8', env: { ...process.env }, timeout: 120_000 }
    );
    console.log(expireOutput);

    // 3. Verify something actually changed
    const afterExpire = await takeSnapshot();
    let creditsChanged = 0;
    for (const [id, snap] of afterExpire.credits) {
      const orig = before.credits.get(id);
      if (orig && orig.expiry_date !== snap.expiry_date) creditsChanged++;
    }
    console.log(`Credits modified by expire script: ${creditsChanged}\n`);

    // 4. Run the revert script
    const mutationsFile = findLatestMutationsFile();
    console.log(`Running revert script with mutations file: ${mutationsFile}\n`);
    const revertOutput = execSync(
      `pnpm script src/scripts/d2026-03-18_expire-free-credits-revert.ts ${mutationsFile} --execute --yes`,
      { cwd: process.cwd(), encoding: 'utf-8', env: { ...process.env }, timeout: 120_000 }
    );
    console.log(revertOutput);

    // 5. Take snapshot of reverted state and compare to original
    const afterRevert = await takeSnapshot();

    const results: AssertionResult[] = [];

    // Check all credits are back to original
    for (const [id, orig] of before.credits) {
      const reverted = afterRevert.credits.get(id);
      results.push({
        name: `Credit ${id.slice(0, 8)}: expiry_date restored`,
        passed: orig.expiry_date === (reverted?.expiry_date ?? null),
        detail: `before=${orig.expiry_date}, after=${reverted?.expiry_date}`,
      });
      results.push({
        name: `Credit ${id.slice(0, 8)}: baseline restored`,
        passed: orig.expiration_baseline === (reverted?.expiration_baseline ?? null),
        detail: `before=${orig.expiration_baseline}, after=${reverted?.expiration_baseline}`,
      });
    }

    // Check user next_credit_expiration_at is correct
    // For USER_EXISTING_EXPIRY: should still point to the independent credit's expiry
    // For others: should be null (no remaining expiring credits)
    for (const userId of ALL_USER_IDS) {
      const orig = before.users.get(userId);
      const reverted = afterRevert.users.get(userId);
      results.push({
        name: `User ${userId.split('-').pop()}: next_credit_expiration_at restored`,
        passed: orig?.next_credit_expiration_at === reverted?.next_credit_expiration_at,
        detail: `before=${orig?.next_credit_expiration_at}, after=${reverted?.next_credit_expiration_at}`,
      });
    }

    // Verify at least some credits were actually changed and reverted
    results.push({
      name: 'Sanity: some credits were modified by expire script',
      passed: creditsChanged > 0,
      detail: `${creditsChanged} credits changed`,
    });

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
