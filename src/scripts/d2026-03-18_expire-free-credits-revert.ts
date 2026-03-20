/**
 * Reverts changes made by the expire-free-credits script using its mutations log.
 *
 * For each credit_transaction mutation, restores expiry_date and
 * expiration_baseline_microdollars_used to their previous values.
 *
 * For each kilocode_user mutation, recomputes next_credit_expiration_at from
 * the user's remaining expiring credits (since other expirations may have been
 * added independently).
 *
 * Usage:
 *   pnpm script src/scripts/d2026-03-18_expire-free-credits-revert.ts <mutations-file>
 *   pnpm script src/scripts/d2026-03-18_expire-free-credits-revert.ts <mutations-file> --execute
 */

import '../lib/load-env';

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import pLimit from 'p-limit';
import { db, closeAllDrizzleConnections } from '@/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';

type CreditMutation = {
  type: 'credit_transaction';
  id: string;
  user_id: string;
  old: {
    expiry_date: string | null;
    expiration_baseline_microdollars_used: number | null;
  };
  new: {
    expiry_date: string;
    expiration_baseline_microdollars_used: number;
  };
};

type UserMutation = {
  type: 'kilocode_user';
  id: string;
  old: {
    next_credit_expiration_at: string | null;
  };
  new: {
    next_credit_expiration_at_input: string;
  };
};

type Mutation = CreditMutation | UserMutation;

async function main() {
  const args = process.argv.slice(2);
  const mutationsFile = args.find(a => !a.startsWith('--'));
  const execute = args.includes('--execute');
  const yes = args.includes('--yes') || args.includes('-y');

  if (!mutationsFile) {
    console.error(
      'Usage: pnpm script src/scripts/d2026-03-18_expire-free-credits-revert.ts <mutations-file> [--execute] [--yes]'
    );
    process.exit(1);
  }

  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`Mutations file: ${mutationsFile}`);

  const dbUrl = process.env.POSTGRES_SCRIPT_URL ?? process.env.POSTGRES_URL ?? '(unknown)';
  const dbHost = (() => {
    try {
      return new URL(dbUrl).hostname;
    } catch {
      return dbUrl;
    }
  })();
  console.log(`Database: ${dbHost}\n`);

  // Parse mutations
  const creditMutations: CreditMutation[] = [];
  const userIds = new Set<string>();

  const rl = createInterface({ input: createReadStream(mutationsFile) });
  for await (const line of rl) {
    const mutation: Mutation = JSON.parse(line);
    if (mutation.type === 'credit_transaction') {
      creditMutations.push(mutation);
    } else if (mutation.type === 'kilocode_user') {
      userIds.add(mutation.id);
    }
  }

  console.log(`Credit transactions to revert: ${creditMutations.length}`);
  console.log(`Users to recompute next_credit_expiration_at: ${userIds.size}\n`);

  if (!execute) {
    console.log('Run with --execute to apply changes.');
    return;
  }

  if (!yes) {
    const confirmRl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      confirmRl.question('Proceed? (y/N) ', resolve);
    });
    confirmRl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
    console.log();
  }

  // Revert credit transactions using their logged old values
  let reverted = 0;
  for (const mutation of creditMutations) {
    await db
      .update(credit_transactions)
      .set({
        expiry_date: mutation.old.expiry_date,
        expiration_baseline_microdollars_used: mutation.old.expiration_baseline_microdollars_used,
      })
      .where(eq(credit_transactions.id, mutation.id));

    reverted++;
    if (reverted % 500 === 0 || reverted === creditMutations.length) {
      console.log(`  Reverted ${reverted}/${creditMutations.length} credit transactions`);
    }
  }

  // Recompute next_credit_expiration_at for each affected user
  const limit = pLimit(50);
  const userIdArray = [...userIds];
  let usersProcessed = 0;

  const results = await Promise.allSettled(
    userIdArray.map(userId =>
      limit(async () => {
        // Find the earliest remaining expiry_date across the user's credits
        const [earliest] = await db
          .select({ expiry_date: credit_transactions.expiry_date })
          .from(credit_transactions)
          .where(
            and(
              eq(credit_transactions.kilo_user_id, userId),
              isNotNull(credit_transactions.expiry_date),
              isNull(credit_transactions.organization_id)
            )
          )
          .orderBy(credit_transactions.expiry_date)
          .limit(1);

        await db
          .update(kilocode_users)
          .set({ next_credit_expiration_at: earliest?.expiry_date ?? null })
          .where(eq(kilocode_users.id, userId));
      })
    )
  );

  for (const r of results) {
    if (r.status === 'fulfilled') usersProcessed++;
    else console.error(`  Error: ${r.reason}`);
  }

  console.log(`\nUsers updated: ${usersProcessed}/${userIds.size}`);
  console.log('Done.');
}

void main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => closeAllDrizzleConnections());
