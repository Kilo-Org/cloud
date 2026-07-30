import { randomUUID } from 'node:crypto';

import { computeDatabaseUrl } from '@kilocode/db';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray, or } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { createSeedStripeCustomer } from '../lib/stripe';
import type { SeedResult } from '../index';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_DAYS = 7;
// The admin router rejects any interval longer than 90 days, so seeding past
// that point produces rows the dashboard can never display.
const MAX_DAYS = 90;
const REVIEWS_PER_DAY = 24;

export const usage = '[--days <1-90>] [--admin-email <email>]';

/**
 * Telemetry fixtures own these ids, so a rerun can delete exactly its own rows
 * without touching real local data.
 */
const SEED_USERS = [
  {
    id: 'c0de5eed-0000-4000-8000-000000000001',
    name: 'Ada Reviewer',
    email: 'code-review-ada@example.com',
  },
  {
    id: 'c0de5eed-0000-4000-8000-000000000002',
    name: 'Grace Reviewer',
    email: 'code-review-grace@example.com',
  },
  {
    id: 'c0de5eed-0000-4000-8000-000000000003',
    name: 'Alan Reviewer',
    email: 'code-review-alan@example.com',
  },
];

const SEED_ORGS = [
  {
    id: 'c0de5eed-0001-4000-8000-000000000001',
    name: '[seed:code-review] Northwind Labs',
    plan: 'teams',
  },
  {
    id: 'c0de5eed-0001-4000-8000-000000000002',
    name: '[seed:code-review] Contoso Robotics',
    plan: 'enterprise',
  },
] satisfies { id: string; name: string; plan: 'teams' | 'enterprise' }[];

const SEED_USER_IDS = SEED_USERS.map(user => user.id);
const SEED_ORG_IDS = SEED_ORGS.map(organization => organization.id);

type SeedOwner =
  | { userId: string; organizationId: null }
  | { userId: null; organizationId: string };

const SEED_OWNERS: SeedOwner[] = [
  ...SEED_USERS.map(user => ({ userId: user.id, organizationId: null })),
  ...SEED_ORGS.map(organization => ({ userId: null, organizationId: organization.id })),
];

const REPOSITORIES = [
  { fullName: 'kilo-seed/web', baseRef: 'main' },
  { fullName: 'kilo-seed/api', baseRef: 'main' },
  { fullName: 'kilo-seed/mobile', baseRef: 'develop' },
  { fullName: 'kilo-seed/infra', baseRef: 'main' },
];

const MODELS = [
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-4.1',
  'google/gemini-2.5-pro',
  'anthropic/claude-opus-4.1',
];

const AUTHORS = ['octocat', 'hubot', 'dependabot', 'seed-contributor'];

/**
 * Chosen so the Error Analysis table lands rows in distinct buckets of
 * `buildErrorCategoryExpr`, rather than piling everything into "Other".
 */
const INFRA_FAILURES = [
  {
    terminalReason: 'sandbox_connection',
    errorMessage: 'Sandbox connection failed after 3 attempts',
  },
  {
    terminalReason: 'workspace_capacity',
    errorMessage: 'sandbox storage full; admission rejected',
  },
  {
    terminalReason: 'assistant_rate_limited_managed',
    errorMessage: 'Assistant returned HTTP 429 while streaming',
  },
  { terminalReason: 'assistant_timeout', errorMessage: 'Assistant timed out after 600s' },
  { terminalReason: 'repository_clone_failed', errorMessage: 'Repository clone failed: ETIMEDOUT' },
  { terminalReason: 'upstream_error', errorMessage: 'Upstream returned HTTP 502' },
  {
    terminalReason: 'github_installation_required',
    errorMessage: 'app installation required for this repository',
  },
  { terminalReason: 'wrapper_failed', errorMessage: 'Agent wrapper exited with code 1' },
];

type Outcome =
  | 'completed'
  | 'failed_infra'
  | 'failed_billing'
  | 'failed_model_unavailable'
  | 'cancelled_user'
  | 'cancelled_superseded'
  | 'interrupted'
  | 'retried_then_completed'
  | 'retried_then_failed';

/**
 * One full cycle is a single day's worth of reviews. The two `retried_*`
 * entries are what make the "Retry-aware metrics" toggle show a difference:
 * final-outcome accounting counts each as one review, all-attempts accounting
 * counts both of their attempts.
 */
const OUTCOME_CYCLE: Outcome[] = [
  ...Array.from({ length: 14 }, (): Outcome => 'completed'),
  'failed_infra',
  'failed_infra',
  'failed_infra',
  'failed_billing',
  'failed_model_unavailable',
  'cancelled_user',
  'cancelled_superseded',
  'interrupted',
  'retried_then_completed',
  'retried_then_failed',
];

/**
 * Live dispatch snapshot for the Current Queue Health section. These are not
 * spread over the date range: the queue health query filters on `now()` only,
 * so the offsets below are what decide which counters light up.
 *
 * Expect: 5 pending (3 older than the 5 minute cutoff), 2 stale queued claims,
 * and 2 runs over the 90 minute cutoff.
 */
const LIVE_QUEUE_ROWS = [
  { status: 'pending', createdMinutesAgo: 2, updatedMinutesAgo: 2, startedMinutesAgo: null },
  { status: 'pending', createdMinutesAgo: 3, updatedMinutesAgo: 3, startedMinutesAgo: null },
  { status: 'pending', createdMinutesAgo: 18, updatedMinutesAgo: 18, startedMinutesAgo: null },
  { status: 'pending', createdMinutesAgo: 42, updatedMinutesAgo: 42, startedMinutesAgo: null },
  { status: 'pending', createdMinutesAgo: 66, updatedMinutesAgo: 66, startedMinutesAgo: null },
  { status: 'queued', createdMinutesAgo: 14, updatedMinutesAgo: 12, startedMinutesAgo: null },
  { status: 'queued', createdMinutesAgo: 9, updatedMinutesAgo: 8, startedMinutesAgo: null },
  { status: 'queued', createdMinutesAgo: 4, updatedMinutesAgo: 1, startedMinutesAgo: null },
  { status: 'running', createdMinutesAgo: 150, updatedMinutesAgo: 130, startedMinutesAgo: 140 },
  { status: 'running', createdMinutesAgo: 120, updatedMinutesAgo: 100, startedMinutesAgo: 110 },
  { status: 'running', createdMinutesAgo: 12, updatedMinutesAgo: 4, startedMinutesAgo: 10 },
];

type TelemetryArgs = { days: number; adminEmail: string | null };

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed code-reviews:telemetry ${usage}`);
  console.log('');
  console.log('Populates /admin/code-reviews with reviews, retry attempts, and a live queue');
  console.log('snapshot owned by dedicated seed users and organizations.');
  console.log('');
  console.log('Options:');
  console.log(`  --days <1-90>        Days of history to generate (default ${DEFAULT_DAYS}).`);
  console.log('  --admin-email <email>  Grant is_admin to an existing user so the admin');
  console.log('                         dashboard is reachable. Optional.');
  console.log('');
  console.log('Reruns delete and rebuild only rows owned by the seed users/organizations.');
}

export function parseTelemetryArgs(args: string[]): TelemetryArgs {
  let days = DEFAULT_DAYS;
  let adminEmail: string | null = null;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== '--days' && flag !== '--admin-email') {
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

    if (flag === '--days') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DAYS) {
        throw new Error(`--days must be an integer between 1 and ${MAX_DAYS}; received ${value}`);
      }
      days = parsed;
      continue;
    }

    adminEmail = value;
  }

  return { days, adminEmail };
}

function assertLocalDatabaseTarget(): string {
  if (process.env.USE_PRODUCTION_DB === 'true') {
    throw new Error('Code review telemetry seed refuses to run with USE_PRODUCTION_DB=true.');
  }

  const databaseUrl = new URL(computeDatabaseUrl());
  const localHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!localHostnames.has(databaseUrl.hostname)) {
    throw new Error(
      `Code review telemetry seed requires a loopback database host; received ${databaseUrl.hostname}.`
    );
  }

  return databaseUrl.hostname;
}

/** Deterministic so reruns produce identical charts. */
function pseudoRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function chooseByIndex<T>(values: T[], index: number, label: string): T {
  const value = values[index % values.length];
  if (value === undefined) {
    throw new Error(`Missing ${label} seed value.`);
  }
  return value;
}

/** Mostly fast, with a long tail so the p95/p99 wait cards differ from the mean. */
function waitSecondsFor(index: number): number {
  const roll = pseudoRandom(index * 7.13);
  if (roll > 0.94) return 900 + Math.floor(roll * 1500);
  if (roll > 0.8) return 300 + Math.floor(roll * 240);
  return 5 + Math.floor(roll * 130);
}

function durationSecondsFor(index: number): number {
  return 90 + Math.floor(pseudoRandom(index * 3.71) * 540);
}

function isoAt(msSinceEpoch: number): string {
  return new Date(msSinceEpoch).toISOString();
}

type ReviewRow = typeof cloud_agent_code_reviews.$inferInsert;
type AttemptRow = typeof cloud_agent_code_review_attempts.$inferInsert;

type GeneratedRows = { reviews: ReviewRow[]; attempts: AttemptRow[] };

function baseReviewFields(
  index: number
): Pick<
  ReviewRow,
  | 'repo_full_name'
  | 'pr_number'
  | 'pr_url'
  | 'pr_title'
  | 'pr_author'
  | 'base_ref'
  | 'head_ref'
  | 'head_sha'
  | 'platform'
  | 'review_type'
  | 'trigger_source'
  | 'agent_version'
> {
  const repository = chooseByIndex(REPOSITORIES, index, 'repository');
  const prNumber = 1000 + index;
  return {
    repo_full_name: repository.fullName,
    pr_number: prNumber,
    pr_url: `https://github.com/${repository.fullName}/pull/${prNumber}`,
    pr_title: `Seed pull request #${prNumber}`,
    pr_author: chooseByIndex(AUTHORS, index, 'author'),
    base_ref: repository.baseRef,
    head_ref: `seed/feature-${prNumber}`,
    head_sha: `${index.toString(16).padStart(8, '0')}${'0'.repeat(32)}`.slice(0, 40),
    platform: 'github',
    review_type: index % 9 === 0 ? 'council' : 'standard',
    trigger_source: index % 5 === 0 ? 'manual' : 'webhook',
    agent_version: 'v2',
  };
}

function usageFields(index: number, completed: boolean): Partial<ReviewRow> {
  if (!completed) return {};
  const tokensIn = 12_000 + Math.floor(pseudoRandom(index * 5.17) * 40_000);
  const tokensOut = 800 + Math.floor(pseudoRandom(index * 9.31) * 4_000);
  return {
    model: chooseByIndex(MODELS, index, 'model'),
    total_tokens_in: tokensIn,
    total_tokens_out: tokensOut,
    total_cost_musd: tokensIn * 3 + tokensOut * 15,
  };
}

function generateHistoricalRows(days: number, nowMs: number): GeneratedRows {
  const reviews: ReviewRow[] = [];
  const attempts: AttemptRow[] = [];
  let index = 0;
  // Rotated independently of `index`: REVIEWS_PER_DAY is a multiple of
  // INFRA_FAILURES.length, so selecting by `index` would pin every day's
  // failure slots to the same few reasons and leave most Error Analysis
  // buckets empty.
  let failureIndex = 0;

  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    for (let slot = 0; slot < REVIEWS_PER_DAY; slot++) {
      const reviewId = randomUUID();
      const outcome = chooseByIndex(OUTCOME_CYCLE, slot, 'outcome');
      const owner = chooseByIndex(SEED_OWNERS, index, 'owner');

      // Spread within the day so DATE_TRUNC('day') buckets stay populated and
      // the interval picker has sub-day resolution to show.
      const dayStart = nowMs - (dayOffset + 1) * DAY_MS;
      const createdAtMs = dayStart + Math.floor((slot / REVIEWS_PER_DAY) * DAY_MS);
      const waitSeconds = waitSecondsFor(index);
      const startedAtMs = createdAtMs + waitSeconds * 1000;
      const durationSeconds = durationSecondsFor(index);
      const completedAtMs = startedAtMs + durationSeconds * 1000;

      const shared = {
        id: reviewId,
        owned_by_user_id: owner.userId,
        owned_by_organization_id: owner.organizationId,
        ...baseReviewFields(index),
        session_id: `agent_seed_${index}`,
        cli_session_id: `ses_seed_${index}`,
        created_at: isoAt(createdAtMs),
        started_at: isoAt(startedAtMs),
        updated_at: isoAt(completedAtMs),
      };

      const pushAttempt = (attempt: Omit<AttemptRow, 'code_review_id'>) => {
        attempts.push({ ...attempt, code_review_id: reviewId });
      };

      if (outcome === 'completed') {
        reviews.push({
          ...shared,
          status: 'completed',
          completed_at: isoAt(completedAtMs),
          ...usageFields(index, true),
        });
        pushAttempt({
          attempt_number: 1,
          status: 'completed',
          session_id: shared.session_id,
          created_at: shared.created_at,
          started_at: shared.started_at,
          completed_at: isoAt(completedAtMs),
          updated_at: isoAt(completedAtMs),
        });
      } else if (outcome === 'failed_infra') {
        const failure = chooseByIndex(INFRA_FAILURES, failureIndex++, 'infra failure');
        reviews.push({
          ...shared,
          status: 'failed',
          completed_at: isoAt(completedAtMs),
          terminal_reason: failure.terminalReason,
          error_message: failure.errorMessage,
        });
        pushAttempt({
          attempt_number: 1,
          status: 'failed',
          session_id: shared.session_id,
          terminal_reason: failure.terminalReason,
          error_message: failure.errorMessage,
          created_at: shared.created_at,
          started_at: shared.started_at,
          completed_at: isoAt(completedAtMs),
          updated_at: isoAt(completedAtMs),
        });
      } else if (outcome === 'failed_billing') {
        reviews.push({
          ...shared,
          status: 'failed',
          completed_at: isoAt(completedAtMs),
          terminal_reason: 'billing',
          error_message: 'Insufficient credits to run this review',
        });
        pushAttempt({
          attempt_number: 1,
          status: 'failed',
          session_id: shared.session_id,
          terminal_reason: 'billing',
          error_message: 'Insufficient credits to run this review',
          created_at: shared.created_at,
          started_at: shared.started_at,
          completed_at: isoAt(completedAtMs),
          updated_at: isoAt(completedAtMs),
        });
      } else if (outcome === 'failed_model_unavailable') {
        reviews.push({
          ...shared,
          status: 'failed',
          completed_at: isoAt(completedAtMs),
          terminal_reason: 'model_not_found',
          error_message: 'Selected model not found on the gateway',
        });
        pushAttempt({
          attempt_number: 1,
          status: 'failed',
          session_id: shared.session_id,
          terminal_reason: 'model_not_found',
          error_message: 'Selected model not found on the gateway',
          created_at: shared.created_at,
          started_at: shared.started_at,
          completed_at: isoAt(completedAtMs),
          updated_at: isoAt(completedAtMs),
        });
      } else if (outcome === 'cancelled_user') {
        reviews.push({
          ...shared,
          status: 'cancelled',
          completed_at: isoAt(completedAtMs),
          terminal_reason: 'user_cancelled',
          error_message: 'Review cancelled by the requesting user',
        });
        pushAttempt({
          attempt_number: 1,
          status: 'cancelled',
          session_id: shared.session_id,
          terminal_reason: 'user_cancelled',
          error_message: 'Review cancelled by the requesting user',
          created_at: shared.created_at,
          started_at: shared.started_at,
          completed_at: isoAt(completedAtMs),
          updated_at: isoAt(completedAtMs),
        });
      } else if (outcome === 'cancelled_superseded') {
        reviews.push({
          ...shared,
          status: 'cancelled',
          completed_at: isoAt(completedAtMs),
          terminal_reason: 'superseded',
          error_message: 'Superseded by a newer commit on the pull request',
        });
        pushAttempt({
          attempt_number: 1,
          status: 'cancelled',
          session_id: shared.session_id,
          terminal_reason: 'superseded',
          error_message: 'Superseded by a newer commit on the pull request',
          created_at: shared.created_at,
          started_at: shared.started_at,
          completed_at: isoAt(completedAtMs),
          updated_at: isoAt(completedAtMs),
        });
      } else if (outcome === 'interrupted') {
        reviews.push({
          ...shared,
          status: 'interrupted',
          completed_at: isoAt(completedAtMs),
          terminal_reason: 'interrupted',
          error_message: 'Container shut down before the review was delivered',
        });
        pushAttempt({
          attempt_number: 1,
          status: 'interrupted',
          session_id: shared.session_id,
          terminal_reason: 'interrupted',
          error_message: 'Container shut down before the review was delivered',
          created_at: shared.created_at,
          started_at: shared.started_at,
          completed_at: isoAt(completedAtMs),
          updated_at: isoAt(completedAtMs),
        });
      } else {
        // Both retry outcomes share a failed first attempt; only the second
        // attempt's status and the review's final status differ.
        const recovered = outcome === 'retried_then_completed';
        const firstFailure = chooseByIndex(INFRA_FAILURES, failureIndex++, 'retry failure');
        const firstCompletedAtMs = startedAtMs + Math.floor(durationSeconds / 3) * 1000;
        const secondCreatedAtMs = firstCompletedAtMs + 30_000;
        const secondStartedAtMs = secondCreatedAtMs + 45_000;
        const secondCompletedAtMs = secondStartedAtMs + durationSeconds * 1000;

        reviews.push({
          ...shared,
          status: recovered ? 'completed' : 'failed',
          completed_at: isoAt(secondCompletedAtMs),
          updated_at: isoAt(secondCompletedAtMs),
          terminal_reason: recovered ? null : firstFailure.terminalReason,
          error_message: recovered ? null : firstFailure.errorMessage,
          ...usageFields(index, recovered),
        });

        const firstAttemptId = randomUUID();
        pushAttempt({
          id: firstAttemptId,
          attempt_number: 1,
          status: 'failed',
          session_id: `${shared.session_id}_a1`,
          terminal_reason: firstFailure.terminalReason,
          error_message: firstFailure.errorMessage,
          created_at: shared.created_at,
          started_at: shared.started_at,
          completed_at: isoAt(firstCompletedAtMs),
          updated_at: isoAt(firstCompletedAtMs),
        });
        pushAttempt({
          attempt_number: 2,
          status: recovered ? 'completed' : 'failed',
          retry_of_attempt_id: firstAttemptId,
          retry_reason: firstFailure.terminalReason,
          session_id: `${shared.session_id}_a2`,
          terminal_reason: recovered ? null : firstFailure.terminalReason,
          error_message: recovered ? null : firstFailure.errorMessage,
          created_at: isoAt(secondCreatedAtMs),
          started_at: isoAt(secondStartedAtMs),
          completed_at: isoAt(secondCompletedAtMs),
          updated_at: isoAt(secondCompletedAtMs),
        });
      }

      index++;
    }
  }

  return { reviews, attempts };
}

function generateLiveQueueRows(nowMs: number, startIndex: number): GeneratedRows {
  const reviews: ReviewRow[] = [];
  const attempts: AttemptRow[] = [];

  for (const [offset, row] of LIVE_QUEUE_ROWS.entries()) {
    const index = startIndex + offset;
    const reviewId = randomUUID();
    const owner = chooseByIndex(SEED_OWNERS, index, 'owner');
    const startedAt =
      row.startedMinutesAgo === null ? null : isoAt(nowMs - row.startedMinutesAgo * MINUTE_MS);

    reviews.push({
      id: reviewId,
      owned_by_user_id: owner.userId,
      owned_by_organization_id: owner.organizationId,
      ...baseReviewFields(index),
      status: row.status,
      session_id: `agent_seed_live_${offset}`,
      cli_session_id: `ses_seed_live_${offset}`,
      created_at: isoAt(nowMs - row.createdMinutesAgo * MINUTE_MS),
      updated_at: isoAt(nowMs - row.updatedMinutesAgo * MINUTE_MS),
      started_at: startedAt,
    });

    attempts.push({
      code_review_id: reviewId,
      attempt_number: 1,
      status: row.status,
      session_id: `agent_seed_live_${offset}`,
      created_at: isoAt(nowMs - row.createdMinutesAgo * MINUTE_MS),
      updated_at: isoAt(nowMs - row.updatedMinutesAgo * MINUTE_MS),
      started_at: startedAt,
    });
  }

  return { reviews, attempts };
}

async function ensureSeedUsers(db: ReturnType<typeof getSeedDb>): Promise<void> {
  const existing = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(inArray(kilocode_users.id, SEED_USER_IDS));
  const existingIds = new Set(existing.map(row => row.id));

  for (const user of SEED_USERS) {
    if (existingIds.has(user.id)) {
      continue;
    }

    // `stripe_customer_id` is NOT NULL and a placeholder makes every
    // Stripe-touching admin page 400 on this user, so create a real test-mode
    // customer the same way app:create-user does.
    const stripeCustomer = await createSeedStripeCustomer({
      email: user.email,
      name: user.name,
      kiloUserId: user.id,
    });

    await db.insert(kilocode_users).values({
      id: user.id,
      google_user_email: user.email,
      google_user_name: user.name,
      google_user_image_url: `https://example.com/${encodeURIComponent(user.id)}.png`,
      stripe_customer_id: stripeCustomer.id,
      normalized_email: normalizeSeedEmail(user.email),
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    });
  }
}

async function ensureSeedOrganizations(db: ReturnType<typeof getSeedDb>): Promise<void> {
  for (const organization of SEED_ORGS) {
    await db
      .insert(organizations)
      .values({ id: organization.id, name: organization.name, plan: organization.plan })
      .onConflictDoUpdate({
        target: organizations.id,
        set: { name: organization.name, plan: organization.plan },
      });
  }
}

async function grantAdmin(db: ReturnType<typeof getSeedDb>, email: string): Promise<string> {
  const normalized = normalizeSeedEmail(email);
  const updated = await db
    .update(kilocode_users)
    .set({ is_admin: true })
    .where(eq(kilocode_users.normalized_email, normalized))
    .returning({ id: kilocode_users.id });

  const row = updated[0];
  if (!row) {
    throw new Error(
      `No user found with email ${email}. Create one first with ` +
        `\`pnpm dev:seed app:create-user "<name>" ${email}\`.`
    );
  }
  return row.id;
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

  const { days, adminEmail } = parseTelemetryArgs(args);
  const databaseHost = assertLocalDatabaseTarget();
  const db = getSeedDb();
  const nowMs = Date.now();

  // Attempts cascade from the review delete, so this clears both tables of
  // fixture rows without touching anything else in the local database.
  await db
    .delete(cloud_agent_code_reviews)
    .where(
      or(
        inArray(cloud_agent_code_reviews.owned_by_user_id, SEED_USER_IDS),
        inArray(cloud_agent_code_reviews.owned_by_organization_id, SEED_ORG_IDS)
      )
    );

  await ensureSeedUsers(db);
  await ensureSeedOrganizations(db);

  const historical = generateHistoricalRows(days, nowMs);
  const live = generateLiveQueueRows(nowMs, historical.reviews.length);
  const reviews = [...historical.reviews, ...live.reviews];
  const attempts = [...historical.attempts, ...live.attempts];

  await insertInChunks(reviews, chunk => db.insert(cloud_agent_code_reviews).values(chunk));
  await insertInChunks(attempts, chunk =>
    db.insert(cloud_agent_code_review_attempts).values(chunk)
  );

  const adminUserId = adminEmail ? await grantAdmin(db, adminEmail) : null;

  console.log('This fixture represents:');
  console.log(
    `  ${days} day(s) of code review history across ${SEED_USERS.length} users and ${SEED_ORGS.length} organizations,`
  );
  console.log('  plus a live queue snapshot with stale pending, queued, and running work.');
  console.log('');
  console.log('Note: the two retried reviews per day are what make the "Retry-aware metrics"');
  console.log('toggle change the numbers. Flip it to compare final-outcome vs all-attempts.');
  console.log('');
  console.log('Suggested next step:');
  console.log('  Open /admin/code-reviews and filter by "code-review-" or "[seed:code-review]".');
  if (!adminEmail) {
    console.log('  If the page 403s, rerun with --admin-email <your local email>.');
  }

  return {
    databaseHost,
    days,
    reviewsInserted: reviews.length,
    attemptsInserted: attempts.length,
    liveQueueReviews: live.reviews.length,
    seedUserIds: SEED_USER_IDS.join(','),
    seedOrganizationIds: SEED_ORG_IDS.join(','),
    userSearchHint: 'code-review-',
    organizationSearchHint: '[seed:code-review]',
    dashboardPath: '/admin/code-reviews',
    adminGrantedUserId: adminUserId,
  };
}
