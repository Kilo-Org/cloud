import { computeDatabaseUrl } from '@kilocode/db';
import { cloud_agent_code_reviews, kilocode_users } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

const MINUTE_MS = 60_000;
const DEFAULT_COUNT = 55;
const MAX_COUNT = 500;
/** A run's start/completion lag behind `created_at`, a few minutes apart. */
const STARTED_AFTER_MINUTES = 2;
const COMPLETED_AFTER_MINUTES = 5;

/** This topic owns these rows, so a rerun deletes exactly its own fixtures. */
const SEED_REPO_FULL_NAME = 'kilo-seed/review-list';
const SEED_PR_NUMBER_BASE = 3000;
/** 8 hex chars of index + zero padding, sliced to a 40-char commit SHA. */
const HEAD_SHA_INDEX_HEX_LENGTH = 8;
const HEAD_SHA_LENGTH = 40;

const MODELS = [
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-4.1',
  'google/gemini-2.5-pro',
  'anthropic/claude-opus-4.1',
];

export const usage = '--email <email> --count <n> [--help]';

type ReviewListArgs = { email: string; count: number };

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed code-reviews:review-list ${usage}`);
  console.log('');
  console.log('Seeds 51+ personal code reviews for one account so the "Recent reviews"');
  console.log('list has a second page. Rows are terminal, so the list never polls.');
  console.log('');
  console.log('Options:');
  console.log('  --email <email>       Account to own the reviews. Required.');
  console.log(`  --count <0-${MAX_COUNT}>       Reviews to insert (default ${DEFAULT_COUNT});`);
  console.log('                        0 resets the account to no seeded rows.');
  console.log('');
  console.log('Reruns delete and rebuild only rows in kilo-seed/review-list owned by');
  console.log('that account; other reviews are untouched.');
}

export function parseReviewListArgs(args: string[]): ReviewListArgs {
  let email: string | null = null;
  let count = DEFAULT_COUNT;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== '--email' && flag !== '--count') {
      printUsage();
      throw new Error(`Unexpected argument: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`Duplicate flag: ${flag}`);
    }
    seen.add(flag);

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    index++;

    if (flag === '--email') {
      email = value;
      continue;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_COUNT) {
      throw new Error(`--count must be an integer between 0 and ${MAX_COUNT}; received ${value}`);
    }
    count = parsed;
  }

  if (!email) {
    printUsage();
    throw new Error('Missing required --email <email>.');
  }

  return { email, count };
}

function assertLocalDatabaseTarget(): string {
  if (process.env.USE_PRODUCTION_DB === 'true') {
    throw new Error('Code review review-list seed refuses to run with USE_PRODUCTION_DB=true.');
  }

  const databaseUrl = new URL(computeDatabaseUrl());
  const localHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!localHostnames.has(databaseUrl.hostname)) {
    throw new Error(
      `Code review review-list seed requires a loopback database host; received ${databaseUrl.hostname}.`
    );
  }

  return databaseUrl.hostname;
}

function chooseByIndex<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index % values.length];
  if (value === undefined) {
    throw new Error(`Missing ${label} seed value.`);
  }
  return value;
}

type ReviewRow = typeof cloud_agent_code_reviews.$inferInsert;

/** Deterministic 40-char commit SHA: hex index prefix plus zero padding. */
function headShaFor(index: number): string {
  const indexHex = index.toString(16).padStart(HEAD_SHA_INDEX_HEX_LENGTH, '0');
  return `${indexHex}${'0'.repeat(HEAD_SHA_LENGTH - HEAD_SHA_INDEX_HEX_LENGTH)}`;
}

function usageFields(index: number, completed: boolean): Partial<ReviewRow> {
  if (!completed) return {};
  const tokensIn = 12_000 + ((index * 977) % 40_000);
  const tokensOut = 800 + ((index * 421) % 4_000);
  return {
    model: chooseByIndex(MODELS, index, 'model'),
    total_tokens_in: tokensIn,
    total_tokens_out: tokensOut,
    total_cost_musd: tokensIn * 3 + tokensOut * 15,
  };
}

/**
 * Deterministic, terminal-only rows. `created_at` descends one minute per row,
 * so item 0001 is the newest and the second page starts at item 0051.
 */
export function generateReviewRows(userId: string, count: number, nowMs: number): ReviewRow[] {
  const rows: ReviewRow[] = [];

  for (let index = 0; index < count; index++) {
    const prNumber = SEED_PR_NUMBER_BASE + index;
    const createdAtMs = nowMs - index * MINUTE_MS;
    const startedAtMs = createdAtMs + STARTED_AFTER_MINUTES * MINUTE_MS;
    const completedAtMs = createdAtMs + COMPLETED_AFTER_MINUTES * MINUTE_MS;
    const completedAt = new Date(completedAtMs).toISOString();
    const status = index % 11 === 10 ? 'failed' : index % 7 === 6 ? 'cancelled' : 'completed';

    rows.push({
      owned_by_user_id: userId,
      repo_full_name: SEED_REPO_FULL_NAME,
      pr_number: prNumber,
      pr_url: `https://github.com/${SEED_REPO_FULL_NAME}/pull/${prNumber}`,
      pr_title: `Seed review ${String(index + 1).padStart(4, '0')}`,
      pr_author: 'seed-contributor',
      base_ref: 'main',
      head_ref: `seed/page-${index + 1}`,
      head_sha: headShaFor(index),
      platform: 'github',
      session_id: `agent_seed_review_list_${index}`,
      cli_session_id: `ses_seed_review_list_${index}`,
      status,
      review_type: 'standard',
      created_at: new Date(createdAtMs).toISOString(),
      started_at: new Date(startedAtMs).toISOString(),
      completed_at: completedAt,
      updated_at: completedAt,
      ...usageFields(index, status === 'completed'),
    });
  }

  return rows;
}

async function insertInChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  const chunkSize = 200;
  for (let start = 0; start < rows.length; start += chunkSize) {
    await insert(rows.slice(start, start + chunkSize));
  }
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const { email, count } = parseReviewListArgs(args);
  const databaseHost = assertLocalDatabaseTarget();
  const db = getSeedDb();
  const normalizedEmail = normalizeSeedEmail(email);

  const users = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail));

  const user = users[0];
  if (!user) {
    throw new Error(
      `No user found with email ${email}. Run ` +
        `\`pnpm dev:seed app:create-user "<name>" ${email}\` (or sign in once with the e2e login) first.`
    );
  }

  // Only this topic's rows: same owner and fixture repository. Never deletes
  // other personal reviews, which may not belong to this seed topic.
  await db
    .delete(cloud_agent_code_reviews)
    .where(
      and(
        eq(cloud_agent_code_reviews.owned_by_user_id, user.id),
        eq(cloud_agent_code_reviews.repo_full_name, SEED_REPO_FULL_NAME)
      )
    );

  const rows = generateReviewRows(user.id, count, Date.now());
  await insertInChunks(rows, chunk => db.insert(cloud_agent_code_reviews).values(chunk));

  const rerunCommand = `pnpm dev:seed code-reviews:review-list --email ${email} --count ${count}`;

  console.log('This fixture represents:');
  console.log(
    `  ${count} terminal code review(s) in ${SEED_REPO_FULL_NAME} owned by ${normalizedEmail},`
  );
  console.log('  ordered newest-first in one-minute steps (item 0001 is newest).');
  console.log('');
  console.log('Note: every row is completed/failed/cancelled, so the list never polls');
  console.log('while you page through it.');
  console.log('');
  console.log('Suggested next step:');
  console.log('  Open the personal "Recent reviews" list and scroll past the first 50.');
  console.log(`  Rerun with: ${rerunCommand}`);

  return {
    databaseHost,
    userId: user.id,
    email: normalizedEmail,
    count,
    pageSize: 50,
    page2Count: Math.max(count - 50, 0),
    firstTitle: 'Seed review 0001',
    lastTitle: count > 0 ? `Seed review ${String(count).padStart(4, '0')}` : null,
    rerunCommand,
  };
}
