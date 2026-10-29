import { computeDatabaseUrl } from '@kilocode/db';
import { cloud_agent_code_reviews, kilocode_users } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

const MINUTE_MS = 60_000;

/** This topic owns these rows, so a rerun deletes exactly its own fixtures. */
const SEED_REPO_FULL_NAME = 'kilo-seed/running-review';
const RUNNING_PR_NUMBER = 4000;
const QUEUED_PR_NUMBER = 4001;
/** 8 hex chars of the PR number plus zero padding, sliced to a 40-char SHA. */
const HEAD_SHA_HEX_LENGTH = 8;
const HEAD_SHA_LENGTH = 40;

/**
 * Ages relative to the seed run. The running review is the newest row, so the
 * list paints it first and the page-one probe starts polling right away; the
 * queued row behind it keeps a second in-flight status to compare against.
 */
const RUNNING_CREATED_MINUTES_AGO = 20;
const RUNNING_STARTED_MINUTES_AGO = 18;
const QUEUED_CREATED_MINUTES_AGO = 40;

export const usage = '--email <email> [--help]';

type RunningReviewArgs = { email: string };

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed code-reviews:running-review ${usage}`);
  console.log('');
  console.log('Seeds one running and one queued code review for one account, so the');
  console.log('"Recent reviews" list polls and the detail screen shows an in-flight status.');
  console.log('');
  console.log('Options:');
  console.log('  --email <email>       Account to own the reviews. Required.');
  console.log('');
  console.log('Reruns delete and rebuild only rows in kilo-seed/running-review owned by');
  console.log('that account; other reviews are untouched.');
}

export function parseRunningReviewArgs(args: string[]): RunningReviewArgs {
  let email: string | null = null;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== '--email') {
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
    email = value;
  }

  if (!email) {
    printUsage();
    throw new Error('Missing required --email <email>.');
  }

  return { email };
}

function assertLocalDatabaseTarget(): string {
  if (process.env.USE_PRODUCTION_DB === 'true') {
    throw new Error('Code review running-review seed refuses to run with USE_PRODUCTION_DB=true.');
  }

  const databaseUrl = new URL(computeDatabaseUrl());
  const localHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!localHostnames.has(databaseUrl.hostname)) {
    throw new Error(
      `Code review running-review seed requires a loopback database host; received ${databaseUrl.hostname}.`
    );
  }

  return databaseUrl.hostname;
}

type ReviewRow = typeof cloud_agent_code_reviews.$inferInsert;

/** Deterministic 40-char commit SHA: hex PR number prefix plus zero padding. */
function headShaFor(prNumber: number): string {
  const prHex = prNumber.toString(16).padStart(HEAD_SHA_HEX_LENGTH, '0');
  return `${prHex}${'0'.repeat(HEAD_SHA_LENGTH - HEAD_SHA_HEX_LENGTH)}`;
}

function reviewRow(
  userId: string,
  args: {
    prNumber: number;
    prTitle: string;
    status: 'running' | 'queued';
    headRef: string;
    createdAtMs: number;
    startedAtMs: number | null;
  }
): ReviewRow {
  const createdAt = new Date(args.createdAtMs).toISOString();
  const startedAt = args.startedAtMs === null ? null : new Date(args.startedAtMs).toISOString();
  return {
    owned_by_user_id: userId,
    repo_full_name: SEED_REPO_FULL_NAME,
    pr_number: args.prNumber,
    pr_url: `https://github.com/${SEED_REPO_FULL_NAME}/pull/${args.prNumber}`,
    pr_title: args.prTitle,
    pr_author: 'seed-contributor',
    base_ref: 'main',
    head_ref: args.headRef,
    head_sha: headShaFor(args.prNumber),
    platform: 'github',
    session_id: `agent_seed_running_review_${args.prNumber}`,
    cli_session_id: `ses_seed_running_review_${args.prNumber}`,
    status: args.status,
    review_type: 'standard',
    created_at: createdAt,
    started_at: startedAt,
    // No completion time: neither row has ended, so the list and the detail
    // screen both take their time from the start (or the creation) instead.
    completed_at: null,
    updated_at: startedAt ?? createdAt,
  };
}

/**
 * Deterministic in-flight rows: a running review whose start is the timestamp
 * every surface reads, and an older queued review that has not started.
 */
export function generateRunningReviewRows(userId: string, nowMs: number): ReviewRow[] {
  return [
    reviewRow(userId, {
      prNumber: RUNNING_PR_NUMBER,
      prTitle: 'Seed review in progress',
      status: 'running',
      headRef: 'seed/running',
      createdAtMs: nowMs - RUNNING_CREATED_MINUTES_AGO * MINUTE_MS,
      startedAtMs: nowMs - RUNNING_STARTED_MINUTES_AGO * MINUTE_MS,
    }),
    reviewRow(userId, {
      prNumber: QUEUED_PR_NUMBER,
      prTitle: 'Seed review queued',
      status: 'queued',
      headRef: 'seed/queued',
      createdAtMs: nowMs - QUEUED_CREATED_MINUTES_AGO * MINUTE_MS,
      startedAtMs: null,
    }),
  ];
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const { email } = parseRunningReviewArgs(args);
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

  // Only this topic's rows: same owner and fixture repository.
  await db
    .delete(cloud_agent_code_reviews)
    .where(
      and(
        eq(cloud_agent_code_reviews.owned_by_user_id, user.id),
        eq(cloud_agent_code_reviews.repo_full_name, SEED_REPO_FULL_NAME)
      )
    );

  await db.insert(cloud_agent_code_reviews).values(generateRunningReviewRows(user.id, Date.now()));

  const rerunCommand = `pnpm dev:seed code-reviews:running-review --email ${email}`;

  console.log('This fixture represents:');
  console.log(
    `  one running and one queued code review in ${SEED_REPO_FULL_NAME} owned by ${normalizedEmail}.`
  );
  console.log('  The running row is newest, so it leads the list and the page-one poll runs.');
  console.log('');
  console.log('Note: neither row ends, so the list keeps polling until they are cleared');
  console.log('(`pnpm dev:seed code-reviews:review-list --email <email> --count 0` does not');
  console.log('delete them; rerun this topic to refresh their ages).');
  console.log('');
  console.log('Suggested next step:');
  console.log('  Open the personal "Recent reviews" list, then open the running review.');
  console.log(`  Rerun with: ${rerunCommand}`);

  return {
    databaseHost,
    userId: user.id,
    email: normalizedEmail,
    runningPrNumber: RUNNING_PR_NUMBER,
    queuedPrNumber: QUEUED_PR_NUMBER,
    runningStartedMinutesAgo: RUNNING_STARTED_MINUTES_AGO,
    repoFullName: SEED_REPO_FULL_NAME,
    rerunCommand,
  };
}
