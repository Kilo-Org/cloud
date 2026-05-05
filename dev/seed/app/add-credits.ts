import { randomUUID } from 'node:crypto';

import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';

const MICRODOLLARS_PER_DOLLAR = 1_000_000;

export const usage = '<user-id> <usd> [options]';

function printUsage(): void {
  console.log('Usage: pnpm dev:seed app:add-credits <user-id> <usd> [options]');
  console.log('       pnpm dev:seed app:add-credits <user-id> --usd=<amount> [options]');
  console.log('       pnpm dev:seed app:add-credits <user-id> --microdollars=<amount> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --free                         Mark the credit transaction as free (default)');
  console.log('  --paid                         Mark the credit transaction as paid/non-free');
  console.log('  --description=<text>           Transaction description');
  console.log('  --category=<text>              credit_category value');
  console.log('  --idempotent                   Enforce one transaction per user/category');
  console.log('  --expires-at=<iso-date>        Expiration timestamp');
  console.log('  --expires-in-days=<number>     Expiration offset from now');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:add-credits user_123 25');
  console.log('  pnpm dev:seed app:add-credits user_123 --usd=50 --paid');
  console.log(
    '  pnpm dev:seed app:add-credits user_123 --microdollars=9000000 --category=dev:kilo'
  );
}

type AddCreditsOptions = {
  userId: string;
  amountMicrodollars: number;
  isFree: boolean;
  description: string;
  creditCategory: string;
  isIdempotent: boolean;
  expiryDateIso: string | null;
};

function parsePositiveInteger(value: string, flagName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive safe integer`);
  }

  return parsed;
}

function parseUsdToMicrodollars(value: string, flagName: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`${flagName} must be a positive dollar amount with up to 6 decimals`);
  }

  const dollars = Number(match[1]);
  const fractional = (match[2] ?? '').padEnd(6, '0');
  const microdollars = dollars * MICRODOLLARS_PER_DOLLAR + Number(fractional);

  if (!Number.isSafeInteger(microdollars) || microdollars <= 0) {
    throw new Error(`${flagName} must be greater than 0 and fit in a safe integer`);
  }

  return microdollars;
}

function parseExpiryDate(value: string, flagName: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${flagName} must be a valid date`);
  }
  if (parsed.getTime() <= Date.now()) {
    throw new Error(`${flagName} must be in the future`);
  }
  return parsed.toISOString();
}

function addDays(date: Date, days: number): string {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString();
}

function parseArgs(args: string[]): AddCreditsOptions {
  const userId = args[0]?.trim();
  if (!userId || userId === '--help' || userId === '-h') {
    printUsage();
    throw new Error('user-id is required');
  }

  let amountMicrodollars: number | null = null;
  let isFree = true;
  let description = 'Dev seed credits';
  let creditCategory = `dev-seed:add-credits:${randomUUID()}`;
  let categoryProvided = false;
  let isIdempotent = false;
  let expiryDateIso: string | null = null;

  for (const arg of args.slice(1)) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      throw new Error('help requested');
    }

    if (arg === '--free') {
      isFree = true;
      continue;
    }

    if (arg === '--paid') {
      isFree = false;
      continue;
    }

    if (arg === '--idempotent') {
      isIdempotent = true;
      continue;
    }

    if (arg.startsWith('--usd=')) {
      if (amountMicrodollars !== null) {
        throw new Error('Specify only one amount');
      }
      amountMicrodollars = parseUsdToMicrodollars(arg.slice('--usd='.length), '--usd');
      continue;
    }

    if (arg.startsWith('--microdollars=')) {
      if (amountMicrodollars !== null) {
        throw new Error('Specify only one amount');
      }
      amountMicrodollars = parsePositiveInteger(
        arg.slice('--microdollars='.length).trim(),
        '--microdollars'
      );
      continue;
    }

    if (arg.startsWith('--description=')) {
      const parsedDescription = arg.slice('--description='.length).trim();
      if (!parsedDescription) {
        throw new Error('--description must not be empty');
      }
      description = parsedDescription;
      continue;
    }

    if (arg.startsWith('--category=')) {
      const parsedCategory = arg.slice('--category='.length).trim();
      if (!parsedCategory) {
        throw new Error('--category must not be empty');
      }
      creditCategory = parsedCategory;
      categoryProvided = true;
      continue;
    }

    if (arg.startsWith('--expires-at=')) {
      if (expiryDateIso !== null) {
        throw new Error('Specify only one expiration option');
      }
      expiryDateIso = parseExpiryDate(arg.slice('--expires-at='.length), '--expires-at');
      continue;
    }

    if (arg.startsWith('--expires-in-days=')) {
      if (expiryDateIso !== null) {
        throw new Error('Specify only one expiration option');
      }
      const days = parsePositiveInteger(
        arg.slice('--expires-in-days='.length).trim(),
        '--expires-in-days'
      );
      expiryDateIso = addDays(new Date(), days);
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (amountMicrodollars !== null) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    amountMicrodollars = parseUsdToMicrodollars(arg, 'amount');
  }

  if (amountMicrodollars === null) {
    printUsage();
    throw new Error('credit amount is required');
  }

  if (isIdempotent && !categoryProvided) {
    throw new Error('--idempotent requires --category');
  }

  return {
    userId,
    amountMicrodollars,
    isFree,
    description,
    creditCategory,
    isIdempotent,
    expiryDateIso,
  };
}

function formatMicrodollarsAsUsd(amountMicrodollars: number): string {
  const sign = amountMicrodollars < 0 ? '-' : '';
  const absolute = Math.abs(amountMicrodollars);
  const dollars = Math.floor(absolute / MICRODOLLARS_PER_DOLLAR);
  const fractional = String(absolute % MICRODOLLARS_PER_DOLLAR).padStart(6, '0');
  return `${sign}$${dollars}.${fractional}`;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const options = parseArgs(args);
  const db = getSeedDb();

  const result = await db.transaction(async tx => {
    const [user] = await tx
      .select({
        id: kilocode_users.id,
        email: kilocode_users.google_user_email,
        microdollarsUsed: kilocode_users.microdollars_used,
        totalMicrodollarsAcquired: kilocode_users.total_microdollars_acquired,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, options.userId))
      .limit(1);

    if (!user) {
      throw new Error(`User ${options.userId} was not found. Sign in locally first.`);
    }

    const nowIso = new Date().toISOString();
    const transactionValues = {
      id: randomUUID(),
      kilo_user_id: user.id,
      amount_microdollars: options.amountMicrodollars,
      is_free: options.isFree,
      description: options.description,
      credit_category: options.creditCategory,
      created_at: nowIso,
      expiry_date: options.expiryDateIso,
      original_baseline_microdollars_used: user.microdollarsUsed,
      expiration_baseline_microdollars_used: options.expiryDateIso ? user.microdollarsUsed : null,
      check_category_uniqueness: options.isIdempotent,
    } satisfies typeof credit_transactions.$inferInsert;

    const insertStatement = tx.insert(credit_transactions).values(transactionValues);
    const insertedTransactions = options.isIdempotent
      ? await insertStatement.onConflictDoNothing().returning({ id: credit_transactions.id })
      : await insertStatement.returning({ id: credit_transactions.id });
    const insertedTransaction = insertedTransactions[0];

    if (!insertedTransaction) {
      return {
        inserted: false,
        user,
        transactionId: null,
        beforeBalanceMicrodollars: user.totalMicrodollarsAcquired - user.microdollarsUsed,
        afterBalanceMicrodollars: user.totalMicrodollarsAcquired - user.microdollarsUsed,
      };
    }

    await tx
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${options.amountMicrodollars}`,
        ...(options.expiryDateIso
          ? {
              next_credit_expiration_at: sql`COALESCE(LEAST(${kilocode_users.next_credit_expiration_at}, ${options.expiryDateIso}), ${options.expiryDateIso})`,
            }
          : {}),
      })
      .where(eq(kilocode_users.id, user.id));

    return {
      inserted: true,
      user,
      transactionId: insertedTransaction.id,
      beforeBalanceMicrodollars: user.totalMicrodollarsAcquired - user.microdollarsUsed,
      afterBalanceMicrodollars:
        user.totalMicrodollarsAcquired - user.microdollarsUsed + options.amountMicrodollars,
    };
  });

  if (!result.inserted) {
    console.log('');
    console.log(
      'No transaction inserted because --idempotent found an existing user/category row.'
    );
  }

  return {
    userId: options.userId,
    email: result.user.email,
    inserted: result.inserted,
    transactionId: result.transactionId,
    amountMicrodollars: options.amountMicrodollars,
    amountUsd: formatMicrodollarsAsUsd(options.amountMicrodollars),
    isFree: options.isFree,
    creditCategory: options.creditCategory,
    expiresAt: options.expiryDateIso,
    beforeBalanceMicrodollars: result.beforeBalanceMicrodollars,
    beforeBalanceUsd: formatMicrodollarsAsUsd(result.beforeBalanceMicrodollars),
    afterBalanceMicrodollars: result.afterBalanceMicrodollars,
    afterBalanceUsd: formatMicrodollarsAsUsd(result.afterBalanceMicrodollars),
  };
}
