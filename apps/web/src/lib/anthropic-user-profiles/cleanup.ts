import { captureException } from '@sentry/nextjs';
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { UserProfile } from '@anthropic-ai/sdk/resources/user-profiles/user-profiles';
import {
  anthropic_user_profile_cleanup_state,
  anthropic_user_profile_deletions,
  claude_billing_connections,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { AnthropicUserProfileDeletionReason } from '@kilocode/db/schema-types';
import {
  deleteAnthropicUserProfile,
  isGatewayAnthropicUserProfile,
  listAnthropicUserProfilesPage,
} from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/api';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { db } from '@kilocode/web-shared/lib/drizzle';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How old a profile, and how long its user's block, must be before it is deleted. */
const GRACE_PERIOD_MS = 30 * DAY_MS;
/** How long completed deletions stay in the log. */
const LOG_RETENTION_MS = 7 * DAY_MS;
const DEFAULT_MAX_QUEUED = 500;
/** Leaves headroom under the route's five-minute `maxDuration`. */
const DEFAULT_BUDGET_MS = 4 * 60 * 1000;
const PENDING_BATCH_SIZE = 100;

type DbOrTransaction = Pick<typeof db, 'select' | 'update' | 'insert'>;

export type AnthropicUserProfileCleanupCounts =
  | { skipped: true }
  | {
      skipped: false;
      pages: number;
      scanned: number;
      candidates: number;
      queuedUnlinked: number;
      queuedUserBlocked: number;
      deleted: number;
      failed: number;
      prunedLogs: number;
      /** Whether the scan reached the end of the list, so the next run starts over. */
      completedPass: boolean;
    };

function isOldEnough(profile: UserProfile, cutoff: Date): boolean {
  return (
    Date.parse(profile.created_at) <= cutoff.getTime() &&
    Date.parse(profile.updated_at) <= cutoff.getTime()
  );
}

/** Profiles of a page that nothing obviously keeps; `queueDeletion` rechecks each one. */
async function deletionCandidates(profiles: UserProfile[], cutoff: Date): Promise<UserProfile[]> {
  if (profiles.length === 0) return [];
  const ids = profiles.map(profile => profile.id);
  const [users, liveOrganizations, billingConnections, queued] = await Promise.all([
    db
      .select({
        profileId: kilocode_users.anthropic_user_profile_id,
        blockedLongEnough: blockedSince(cutoff),
      })
      .from(kilocode_users)
      .where(inArray(kilocode_users.anthropic_user_profile_id, ids)),
    db
      .select({ profileId: organizations.anthropic_user_profile_id })
      .from(organizations)
      .where(
        and(inArray(organizations.anthropic_user_profile_id, ids), isNull(organizations.deleted_at))
      ),
    db
      .select({ profileId: claude_billing_connections.user_profile_id })
      .from(claude_billing_connections)
      .where(inArray(claude_billing_connections.user_profile_id, ids)),
    db
      .select({ profileId: anthropic_user_profile_deletions.user_profile_id })
      .from(anthropic_user_profile_deletions)
      .where(inArray(anthropic_user_profile_deletions.user_profile_id, ids)),
  ]);
  const kept = new Set<string | null>([
    ...liveOrganizations.map(row => row.profileId),
    ...billingConnections.map(row => row.profileId),
    ...queued.map(row => row.profileId),
    ...users.filter(user => !user.blockedLongEnough).map(user => user.profileId),
  ]);
  return profiles.filter(profile => !kept.has(profile.id));
}

function blockedSince(cutoff: Date) {
  return sql<boolean>`coalesce(${kilocode_users.blocked_at} <= ${cutoff.toISOString()}::timestamptz, false)`;
}

/**
 * Detaches the profile and queues its remote delete in one transaction, after
 * rechecking under row locks that nothing still needs it. Returns the reason it
 * was queued for, or null when it is kept or already queued.
 */
async function queueDeletion(
  profile: UserProfile,
  cutoff: Date
): Promise<AnthropicUserProfileDeletionReason | null> {
  return await db.transaction(async tx => {
    const users = await tx
      .select({ id: kilocode_users.id, blockedLongEnough: blockedSince(cutoff) })
      .from(kilocode_users)
      .where(eq(kilocode_users.anthropic_user_profile_id, profile.id))
      .for('update');
    if (users.some(user => !user.blockedLongEnough)) return null;
    if (await isReferencedOutsideUsers(tx, profile.id)) return null;

    const reason =
      users.length === 0
        ? AnthropicUserProfileDeletionReason.Unlinked
        : AnthropicUserProfileDeletionReason.UserBlocked;
    if (users.length > 0) {
      await tx
        .update(kilocode_users)
        .set({ anthropic_user_profile_id: null })
        .where(eq(kilocode_users.anthropic_user_profile_id, profile.id));
    }
    const [queued] = await tx
      .insert(anthropic_user_profile_deletions)
      .values({
        user_profile_id: profile.id,
        reason,
        kilo_user_id: users[0]?.id ?? null,
        profile_created_at: profile.created_at,
        profile_updated_at: profile.updated_at,
      })
      .onConflictDoNothing({ target: anthropic_user_profile_deletions.user_profile_id })
      .returning({ id: anthropic_user_profile_deletions.id });
    return queued ? reason : null;
  });
}

async function isReferencedOutsideUsers(tx: DbOrTransaction, userProfileId: string) {
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        eq(organizations.anthropic_user_profile_id, userProfileId),
        isNull(organizations.deleted_at)
      )
    )
    .limit(1);
  if (organization) return true;
  const [billing] = await tx
    .select({ id: claude_billing_connections.id })
    .from(claude_billing_connections)
    .where(eq(claude_billing_connections.user_profile_id, userProfileId))
    .limit(1);
  return billing !== undefined;
}

async function readNextPage(): Promise<string | null> {
  const [state] = await db
    .select({ nextPage: anthropic_user_profile_cleanup_state.next_page })
    .from(anthropic_user_profile_cleanup_state)
    .where(eq(anthropic_user_profile_cleanup_state.id, 1));
  return state?.nextPage ?? null;
}

async function saveNextPage(nextPage: string | null): Promise<void> {
  await db
    .insert(anthropic_user_profile_cleanup_state)
    .values({ id: 1, next_page: nextPage })
    .onConflictDoUpdate({
      target: anthropic_user_profile_cleanup_state.id,
      set: { next_page: nextPage },
    });
}

function reportFailure(message: string, userProfileId: string | null, error: unknown) {
  console.error(`[anthropic-user-profile-cleanup] ${message}`, {
    userProfileId,
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  captureException(error, {
    tags: { source: 'anthropic-user-profile-cleanup' },
    extra: { userProfileId },
  });
}

/**
 * Deletes Anthropic user profiles that nothing uses any more: profiles no user or
 * live organization references, and profiles only users blocked for 30 days
 * reference. Profiles created or updated in the last 30 days and Claude billing
 * profiles are never touched.
 *
 * A profile is detached and queued in one transaction, then deleted at
 * Anthropic; a failed delete stays queued and is retried on later runs. The scan
 * of the oldest-first profile list stops at a time budget and continues from
 * the saved page on the next run.
 */
export async function runAnthropicUserProfileCleanup({
  now = new Date(),
  maxQueued = DEFAULT_MAX_QUEUED,
  budgetMs = DEFAULT_BUDGET_MS,
}: {
  now?: Date;
  maxQueued?: number;
  budgetMs?: number;
} = {}): Promise<AnthropicUserProfileCleanupCounts> {
  if (!isClaudeOperatorConfigured()) return { skipped: true };

  const startedAt = Date.now();
  // Half the budget scans, so queued deletes always get time to run.
  const scanDeadline = startedAt + budgetMs / 2;
  const deadline = startedAt + budgetMs;
  const cutoff = new Date(now.getTime() - GRACE_PERIOD_MS);
  const logCutoff = new Date(now.getTime() - LOG_RETENTION_MS);
  const counts = {
    pages: 0,
    scanned: 0,
    candidates: 0,
    queuedUnlinked: 0,
    queuedUserBlocked: 0,
    deleted: 0,
    failed: 0,
    prunedLogs: 0,
    completedPass: false,
  };

  let page = await readNextPage();
  while (
    Date.now() < scanDeadline &&
    counts.queuedUnlinked + counts.queuedUserBlocked < maxQueued
  ) {
    const { profiles, nextPage } = await listAnthropicUserProfilesPage(page);
    counts.pages++;
    counts.scanned += profiles.length;
    const old = profiles.filter(
      profile => isGatewayAnthropicUserProfile(profile) && isOldEnough(profile, cutoff)
    );
    let stoppedMidPage = false;
    for (const profile of await deletionCandidates(old, cutoff)) {
      if (counts.queuedUnlinked + counts.queuedUserBlocked >= maxQueued) {
        stoppedMidPage = true;
        break;
      }
      counts.candidates++;
      try {
        const reason = await queueDeletion(profile, cutoff);
        if (reason === AnthropicUserProfileDeletionReason.Unlinked) counts.queuedUnlinked++;
        if (reason === AnthropicUserProfileDeletionReason.UserBlocked) counts.queuedUserBlocked++;
      } catch (error) {
        counts.failed++;
        reportFailure('failed to queue profile deletion', profile.id, error);
      }
    }
    // Rescan this page next run instead of skipping its unqueued candidates.
    if (stoppedMidPage) break;
    // The list is oldest first, so a profile created after the cutoff ends the
    // useful part of the pass.
    const reachedRecent = profiles.some(
      profile => Date.parse(profile.created_at) > cutoff.getTime()
    );
    page = reachedRecent ? null : nextPage;
    await saveNextPage(page);
    if (page === null) {
      counts.completedPass = true;
      break;
    }
  }

  // Each pending delete is attempted at most once per run.
  const runStartedAt = new Date(startedAt).toISOString();
  while (Date.now() < deadline) {
    const pending = await db
      .select({
        id: anthropic_user_profile_deletions.id,
        userProfileId: anthropic_user_profile_deletions.user_profile_id,
      })
      .from(anthropic_user_profile_deletions)
      .where(
        and(
          isNull(anthropic_user_profile_deletions.deleted_at),
          or(
            isNull(anthropic_user_profile_deletions.last_attempt_at),
            lt(anthropic_user_profile_deletions.last_attempt_at, runStartedAt)
          )
        )
      )
      .orderBy(asc(anthropic_user_profile_deletions.queued_at))
      .limit(PENDING_BATCH_SIZE);
    if (pending.length === 0) break;
    for (const job of pending) {
      if (Date.now() >= deadline) break;
      let deleted = false;
      try {
        await deleteAnthropicUserProfile(job.userProfileId);
        deleted = true;
        counts.deleted++;
      } catch (error) {
        counts.failed++;
        reportFailure('failed to delete profile', job.userProfileId, error);
      }
      await db
        .update(anthropic_user_profile_deletions)
        .set({
          attempt_count: sql`${anthropic_user_profile_deletions.attempt_count} + 1`,
          // App time, like `runStartedAt`, so clock skew cannot retry it within this run.
          last_attempt_at: new Date().toISOString(),
          ...(deleted ? { deleted_at: sql`now()` } : {}),
        })
        .where(eq(anthropic_user_profile_deletions.id, job.id));
    }
    if (pending.length < PENDING_BATCH_SIZE) break;
  }

  const pruned = await db
    .delete(anthropic_user_profile_deletions)
    .where(
      and(
        isNotNull(anthropic_user_profile_deletions.deleted_at),
        lt(anthropic_user_profile_deletions.deleted_at, logCutoff.toISOString())
      )
    )
    .returning({ id: anthropic_user_profile_deletions.id });
  counts.prunedLogs = pruned.length;

  return { skipped: false, ...counts };
}
