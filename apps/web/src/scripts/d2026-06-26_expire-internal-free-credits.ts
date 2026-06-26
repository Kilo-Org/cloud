/**
 * Immediately expires ALL free credit grants (with or without an existing expiry
 * date) belonging to internal team accounts — users whose email ends in
 * @kilocode.ai or @kilo.ai — while keeping their balances non-negative.
 *
 * Per user:
 *   - Every free, personal, positive credit grant that hasn't already been
 *     expired is tagged with expiry_date = now and then expired (the unspent
 *     remainder is removed from the balance via a credits_expired transaction).
 *       · Fully-spent grants expire $0 → effectively left alone.
 *       · Partially-spent grants expire their unspent remainder.
 *   - If expiring those grants drives the balance below zero (accounting quirks,
 *     e.g. spend clawed back via total_microdollars_acquired), a one-off
 *     `accounting_adjustment` credit tops the balance back to exactly $0.
 *
 * Reuses processLocalExpirations() for the actual expiry so the math matches the
 * production expiration cron exactly.
 *
 * Usage:
 *   pnpm script src/scripts/d2026-06-26_expire-internal-free-credits.ts
 *   pnpm script src/scripts/d2026-06-26_expire-internal-free-credits.ts --execute
 */

import '../lib/load-env';

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import pLimit from 'p-limit';
import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { and, eq, gt, isNull, sql, inArray, or } from 'drizzle-orm';
import {
  computeExpiration,
  processLocalExpirations,
  type ExpiringTransaction,
} from '@/lib/creditExpiration';

// ── Constants ────────────────────────────────────────────────────────────────

/** Email suffixes that mark an internal team account. */
const INTERNAL_DOMAINS = ['kilocode.ai', 'kilo.ai'];

const EXPIRED_CATEGORIES = ['credits_expired', 'orb_credit_expired', 'orb_credit_voided'] as const;

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(): { execute: boolean; yes: boolean; batchSize: number; concurrency: number } {
  const args = process.argv.slice(2);
  let execute = false;
  let yes = false;
  let batchSize = 500;
  let concurrency = 50;

  for (const arg of args) {
    if (arg === '--execute') {
      execute = true;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg.startsWith('--batch-size=')) {
      const value = parseInt(arg.split('=')[1], 10);
      if (isNaN(value) || value <= 0) {
        console.error(`Invalid --batch-size value: ${arg}`);
        process.exit(1);
      }
      batchSize = value;
    } else if (arg.startsWith('--concurrency=')) {
      const value = parseInt(arg.split('=')[1], 10);
      if (isNaN(value) || value <= 0) {
        console.error(`Invalid --concurrency value: ${arg}`);
        process.exit(1);
      }
      concurrency = value;
    }
  }

  return { execute, yes, batchSize, concurrency };
}

// ── Process a single user ────────────────────────────────────────────────────

type AffectedUser = {
  id: string;
  google_user_email: string;
  microdollars_used: number;
  total_microdollars_acquired: number;
  next_credit_expiration_at: string | null;
  updated_at: string;
};

type UserResult = {
  freeCreditsTargeted: number;
  totalExpiredMicrodollars: number;
  balanceAfterExpiryMicrodollars: number;
  oneOffFixMicrodollars: number;
  finalBalanceMicrodollars: number;
};

async function processUser(
  user: AffectedUser,
  expiryDateIso: string,
  execute: boolean,
  output: ReturnType<typeof createWriteStream>,
  mutationLog: ReturnType<typeof createWriteStream>
): Promise<UserResult> {
  // 1. Fetch all personal credit transactions (excluding org-scoped).
  const allTransactions = await db
    .select()
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.kilo_user_id, user.id),
        isNull(credit_transactions.organization_id)
      )
    );

  // 2. Grants that have already been expired — never re-expire these.
  const processedOriginalIds = new Set(
    allTransactions
      .filter(
        t =>
          t.original_transaction_id != null &&
          (EXPIRED_CATEGORIES as readonly string[]).includes(t.credit_category ?? '')
      )
      .map(t => t.original_transaction_id)
  );

  // 3. Affected = every free, positive grant not already expired (with OR without
  //    an existing expiry date). These all get expiry_date = now.
  const affectedCredits = allTransactions.filter(
    t => t.is_free && t.amount_microdollars > 0 && !processedOriginalIds.has(t.id)
  );

  const baseResult: UserResult = {
    freeCreditsTargeted: 0,
    totalExpiredMicrodollars: 0,
    balanceAfterExpiryMicrodollars: user.total_microdollars_acquired - user.microdollars_used,
    oneOffFixMicrodollars: 0,
    finalBalanceMicrodollars: user.total_microdollars_acquired - user.microdollars_used,
  };
  if (affectedCredits.length === 0) return baseResult;

  const affectedIds = new Set(affectedCredits.map(t => t.id));

  // 4. Build the post-change expiring set, mirroring fetchExpiringTransactions:
  //    every unprocessed expiry-dated transaction, with affected free grants
  //    re-dated to now. Run the simulation at `now`.
  const simulationInput: ExpiringTransaction[] = allTransactions
    .filter(
      t => !processedOriginalIds.has(t.id) && (affectedIds.has(t.id) || t.expiry_date != null)
    )
    .map(t => ({
      id: t.id,
      amount_microdollars: t.amount_microdollars,
      expiration_baseline_microdollars_used: affectedIds.has(t.id)
        ? (t.original_baseline_microdollars_used ?? 0)
        : t.expiration_baseline_microdollars_used,
      expiry_date: affectedIds.has(t.id) ? expiryDateIso : t.expiry_date,
      description: t.description,
      is_free: t.is_free,
    }));

  const entity = { id: user.id, microdollars_used: user.microdollars_used };
  const { newTransactions } = computeExpiration(
    simulationInput,
    entity,
    new Date(expiryDateIso),
    user.id
  );

  const expiredByOriginalId = new Map(
    newTransactions.map(t => [t.original_transaction_id, Math.abs(t.amount_microdollars ?? 0)])
  );

  // total_expired is negative (credits_expired amounts are negative).
  const totalExpired = newTransactions.reduce((sum, t) => sum + (t.amount_microdollars ?? 0), 0);
  const currentBalance = user.total_microdollars_acquired - user.microdollars_used;
  const balanceAfterExpiry = currentBalance + totalExpired;
  const oneOffFix = balanceAfterExpiry < 0 ? -balanceAfterExpiry : 0;
  const finalBalance = balanceAfterExpiry + oneOffFix;

  // 5. Log JSONL line.
  output.write(
    JSON.stringify({
      user_id: user.id,
      email: user.google_user_email,
      current_balance_microdollars: currentBalance,
      free_credits_targeted: affectedCredits.length,
      total_expired_microdollars: -totalExpired,
      balance_after_expiry_microdollars: balanceAfterExpiry,
      one_off_fix_microdollars: oneOffFix,
      final_balance_microdollars: finalBalance,
      credits: affectedCredits.map(t => ({
        id: t.id,
        credit_category: t.credit_category,
        amount_microdollars: t.amount_microdollars,
        had_expiry_date: t.expiry_date,
        projected_expired_microdollars: expiredByOriginalId.get(t.id) ?? 0,
      })),
    }) + '\n'
  );

  // 6. Mutation log (both modes; in execute, after commit).
  const logMutations = () => {
    for (const t of affectedCredits) {
      mutationLog.write(
        JSON.stringify({
          type: 'credit_transaction_expiry',
          id: t.id,
          user_id: user.id,
          old: {
            expiry_date: t.expiry_date,
            expiration_baseline_microdollars_used: t.expiration_baseline_microdollars_used,
          },
          new: {
            expiry_date: expiryDateIso,
            expiration_baseline_microdollars_used: t.original_baseline_microdollars_used ?? 0,
          },
        }) + '\n'
      );
    }
    if (oneOffFix > 0) {
      mutationLog.write(
        JSON.stringify({
          type: 'accounting_adjustment_insert',
          user_id: user.id,
          amount_microdollars: oneOffFix,
        }) + '\n'
      );
    }
  };

  if (!execute) {
    logMutations();
    return {
      freeCreditsTargeted: affectedCredits.length,
      totalExpiredMicrodollars: -totalExpired,
      balanceAfterExpiryMicrodollars: balanceAfterExpiry,
      oneOffFixMicrodollars: oneOffFix,
      finalBalanceMicrodollars: finalBalance,
    };
  }

  // 7. Execute: tag affected grants with expiry = now, then run the real
  //    expiration (inserts credits_expired, decrements total_microdollars_acquired),
  //    then top up any negative balance to $0 with an accounting_adjustment.
  await db
    .update(credit_transactions)
    .set({
      expiry_date: expiryDateIso,
      expiration_baseline_microdollars_used: sql`COALESCE(${credit_transactions.original_baseline_microdollars_used}, 0)`,
    })
    .where(inArray(credit_transactions.id, [...affectedIds]));

  const expirationOutcome = await processLocalExpirations(
    {
      id: user.id,
      microdollars_used: user.microdollars_used,
      next_credit_expiration_at: user.next_credit_expiration_at,
      updated_at: user.updated_at,
      total_microdollars_acquired: user.total_microdollars_acquired,
    },
    new Date(expiryDateIso)
  );

  const acquiredAfter =
    expirationOutcome?.total_microdollars_acquired ?? user.total_microdollars_acquired;
  const realBalanceAfter = acquiredAfter - user.microdollars_used;

  if (realBalanceAfter < 0) {
    const fix = -realBalanceAfter;
    await db.transaction(async tx => {
      await tx.insert(credit_transactions).values({
        kilo_user_id: user.id,
        amount_microdollars: fix,
        is_free: true,
        credit_category: 'accounting_adjustment',
        description: 'Correction to $0 after expiring internal free credits',
        original_baseline_microdollars_used: user.microdollars_used,
      });
      await tx
        .update(kilocode_users)
        .set({ total_microdollars_acquired: acquiredAfter + fix })
        .where(
          and(
            eq(kilocode_users.id, user.id),
            eq(kilocode_users.total_microdollars_acquired, acquiredAfter)
          )
        );
    });
  }

  logMutations();

  return {
    freeCreditsTargeted: affectedCredits.length,
    totalExpiredMicrodollars: -totalExpired,
    balanceAfterExpiryMicrodollars: realBalanceAfter,
    oneOffFixMicrodollars: realBalanceAfter < 0 ? -realBalanceAfter : 0,
    finalBalanceMicrodollars: Math.max(0, realBalanceAfter),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const { execute, yes, batchSize, concurrency } = parseArgs();

  // Expire immediately: same instant for the whole run.
  const expiryDateIso = new Date().toISOString();

  const emailMatch = or(
    ...INTERNAL_DOMAINS.map(d => sql`lower(${kilocode_users.google_user_email}) like ${'%@' + d}`)
  );

  const users: AffectedUser[] = await db
    .select({
      id: kilocode_users.id,
      google_user_email: kilocode_users.google_user_email,
      microdollars_used: kilocode_users.microdollars_used,
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      updated_at: kilocode_users.updated_at,
    })
    .from(kilocode_users)
    .where(emailMatch);

  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`Internal domains: ${INTERNAL_DOMAINS.map(d => '@' + d).join(', ')}`);
  console.log(`Expiry date (now): ${expiryDateIso}`);
  console.log(`Matching users:    ${users.length}`);
  console.log(`Batch size:        ${batchSize}`);
  console.log(`Concurrency:       ${concurrency}\n`);

  if (users.length === 0) {
    console.log('No matching users. Nothing to do.');
    return;
  }

  // Identify which matched users actually hold a free, positive, personal grant.
  const usersById = new Map(users.map(u => [u.id, u]));
  const userIdsWithFree = new Set<string>();
  for (const idChunk of chunk(
    users.map(u => u.id),
    batchSize
  )) {
    const rows = await db
      .selectDistinct({ kilo_user_id: credit_transactions.kilo_user_id })
      .from(credit_transactions)
      .where(
        and(
          inArray(credit_transactions.kilo_user_id, idChunk),
          eq(credit_transactions.is_free, true),
          isNull(credit_transactions.organization_id),
          gt(credit_transactions.amount_microdollars, 0)
        )
      );
    for (const r of rows) userIdsWithFree.add(r.kilo_user_id);
  }

  // Show DB target and ask for confirmation.
  const dbUrl = process.env.POSTGRES_SCRIPT_URL ?? process.env.POSTGRES_URL ?? '(unknown)';
  const dbHost = (() => {
    try {
      return new URL(dbUrl).hostname;
    } catch {
      return dbUrl;
    }
  })();
  console.log(`Database: ${dbHost}`);
  console.log(`Users holding free credits: ${userIdsWithFree.size}`);
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question(`\nProceed? (y/N) `, resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }
  console.log();

  const outputDir = path.join(__dirname, 'output');
  await mkdir(outputDir, { recursive: true });
  const timestamp = expiryDateIso.replace(/:/g, '-');
  const output = createWriteStream(
    path.join(outputDir, `expire-internal-free-credits-${timestamp}.jsonl`)
  );
  const errorLog = createWriteStream(
    path.join(outputDir, `expire-internal-free-credits-${timestamp}.errors.jsonl`)
  );
  const mutationLog = createWriteStream(
    path.join(outputDir, `expire-internal-free-credits-${timestamp}.mutations.jsonl`)
  );
  console.log(`Output:    ${output.path}`);
  console.log(`Mutations: ${mutationLog.path}`);
  console.log(`Errors:    ${errorLog.path}\n`);

  const limit = pLimit(concurrency);

  let usersProcessed = 0;
  let totalCreditsTargeted = 0;
  let totalExpired = 0;
  let usersFixed = 0;
  let totalFix = 0;
  let totalErrors = 0;

  const results = await Promise.allSettled(
    [...userIdsWithFree].map(userId =>
      limit(async () => {
        const user = usersById.get(userId);
        if (!user) throw new Error(`User ${userId} not found in matched set`);
        return processUser(user, expiryDateIso, execute, output, mutationLog);
      })
    )
  );

  for (const settled of results) {
    if (settled.status === 'rejected') {
      totalErrors++;
      const error =
        settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      errorLog.write(JSON.stringify({ error }) + '\n');
    } else {
      usersProcessed++;
      totalCreditsTargeted += settled.value.freeCreditsTargeted;
      totalExpired += settled.value.totalExpiredMicrodollars;
      if (settled.value.oneOffFixMicrodollars > 0) {
        usersFixed++;
        totalFix += settled.value.oneOffFixMicrodollars;
      }
    }
  }

  output.end();
  errorLog.end();
  mutationLog.end();

  const fmt = (microdollars: number) =>
    `$${(microdollars / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  console.log('\n--- Summary ---');
  console.log(`Matching users:              ${users.length}`);
  console.log(`Users holding free credits:  ${userIdsWithFree.size}`);
  console.log(`Users processed:             ${usersProcessed}`);
  console.log(`Free credits targeted:       ${totalCreditsTargeted}`);
  console.log(`Total expired (removed):     ${fmt(totalExpired)}`);
  console.log(`Users needing $0 fix:        ${usersFixed}`);
  console.log(`Total one-off fix credited:  ${fmt(totalFix)}`);
  console.log(`Errors:                      ${totalErrors}`);
  console.log(`Mode:                        ${execute ? 'EXECUTED' : 'DRY RUN'}`);
}

void main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => closeAllDrizzleConnections());
