import { captureException } from '@sentry/nextjs';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { UserProfile } from '@anthropic-ai/sdk/resources/user-profiles/user-profiles';
import {
  anthropic_user_profile_deletions,
  claude_billing_connections,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { AnthropicUserProfileDeletionReason } from '@kilocode/db/schema-types';
import {
  deleteAnthropicUserProfile,
  isGatewayAnthropicUserProfile,
  listAnthropicUserProfiles,
} from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/api';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { db } from '@kilocode/web-shared/lib/drizzle';

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
const DEFAULT_MAX_DELETIONS = 500;

export type AnthropicUserProfileCleanupCounts =
  | { skipped: true }
  | {
      skipped: false;
      scanned: number;
      candidates: number;
      deletedUnlinked: number;
      deletedUserBlocked: number;
      kept: number;
      failed: number;
      prunedLogs: number;
    };

type Decision =
  | { action: 'keep' }
  | { action: 'delete'; reason: AnthropicUserProfileDeletionReason; userIds: string[] };

function isOldEnough(profile: UserProfile, cutoff: number): boolean {
  return Date.parse(profile.created_at) <= cutoff && Date.parse(profile.updated_at) <= cutoff;
}

async function decideBatch(profiles: UserProfile[], cutoff: Date): Promise<Map<string, Decision>> {
  const ids = profiles.map(profile => profile.id);
  const [users, liveOrganizations, billingConnections] = await Promise.all([
    db
      .select({
        id: kilocode_users.id,
        profileId: kilocode_users.anthropic_user_profile_id,
        blockedLongEnough: sql<boolean>`${kilocode_users.blocked_at} IS NOT NULL AND ${kilocode_users.blocked_at} <= ${cutoff.toISOString()}::timestamptz`,
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
  ]);

  const usersByProfile = new Map<string, typeof users>();
  for (const user of users) {
    if (!user.profileId) continue;
    usersByProfile.set(user.profileId, [...(usersByProfile.get(user.profileId) ?? []), user]);
  }
  const organizationProfiles = new Set(liveOrganizations.map(row => row.profileId));
  const billingProfiles = new Set(billingConnections.map(row => row.profileId));

  const decisions = new Map<string, Decision>();
  for (const id of ids) {
    const linkedUsers = usersByProfile.get(id) ?? [];
    if (billingProfiles.has(id) || organizationProfiles.has(id)) {
      decisions.set(id, { action: 'keep' });
    } else if (linkedUsers.length === 0) {
      decisions.set(id, {
        action: 'delete',
        reason: AnthropicUserProfileDeletionReason.Unlinked,
        userIds: [],
      });
    } else if (linkedUsers.every(user => user.blockedLongEnough)) {
      decisions.set(id, {
        action: 'delete',
        reason: AnthropicUserProfileDeletionReason.UserBlocked,
        userIds: linkedUsers.map(user => user.id),
      });
    } else {
      decisions.set(id, { action: 'keep' });
    }
  }
  return decisions;
}

async function deleteProfile(
  profile: UserProfile,
  decision: Extract<Decision, { action: 'delete' }>
): Promise<void> {
  await deleteAnthropicUserProfile(profile.id);
  await db.transaction(async tx => {
    if (decision.reason === AnthropicUserProfileDeletionReason.UserBlocked) {
      await tx
        .update(kilocode_users)
        .set({ anthropic_user_profile_id: null })
        .where(eq(kilocode_users.anthropic_user_profile_id, profile.id));
    }
    await tx.insert(anthropic_user_profile_deletions).values({
      user_profile_id: profile.id,
      reason: decision.reason,
      kilo_user_id: decision.userIds[0] ?? null,
      profile_created_at: profile.created_at,
      profile_updated_at: profile.updated_at,
    });
  });
  console.info('[anthropic-user-profile-cleanup] deleted profile', {
    userProfileId: profile.id,
    reason: decision.reason,
    ...(decision.userIds[0] ? { kiloUserId: decision.userIds[0] } : {}),
  });
}

/**
 * Deletes Anthropic user profiles that nothing uses any more: profiles no user or
 * organization references, and profiles only users blocked for a week reference.
 * Profiles younger than a week are never touched, nor are Claude billing profiles.
 */
export async function runAnthropicUserProfileCleanup({
  now = new Date(),
  maxDeletions = DEFAULT_MAX_DELETIONS,
}: { now?: Date; maxDeletions?: number } = {}): Promise<AnthropicUserProfileCleanupCounts> {
  if (!isClaudeOperatorConfigured()) return { skipped: true };

  const cutoff = new Date(now.getTime() - GRACE_PERIOD_MS);
  const counts = {
    scanned: 0,
    candidates: 0,
    deletedUnlinked: 0,
    deletedUserBlocked: 0,
    kept: 0,
    failed: 0,
    prunedLogs: 0,
  };

  const processBatch = async (batch: UserProfile[]) => {
    const decisions = await decideBatch(batch, cutoff);
    for (const profile of batch) {
      const decision = decisions.get(profile.id) ?? { action: 'keep' };
      if (decision.action === 'keep') {
        counts.kept++;
        continue;
      }
      if (counts.deletedUnlinked + counts.deletedUserBlocked >= maxDeletions) continue;
      try {
        await deleteProfile(profile, decision);
        if (decision.reason === AnthropicUserProfileDeletionReason.Unlinked) {
          counts.deletedUnlinked++;
        } else {
          counts.deletedUserBlocked++;
        }
      } catch (error) {
        counts.failed++;
        console.error('[anthropic-user-profile-cleanup] failed to delete profile', {
          userProfileId: profile.id,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        captureException(error, {
          tags: { source: 'anthropic-user-profile-cleanup' },
          extra: { userProfileId: profile.id },
        });
      }
    }
  };

  const deletedCount = () => counts.deletedUnlinked + counts.deletedUserBlocked;
  let batch: UserProfile[] = [];
  for await (const profile of listAnthropicUserProfiles()) {
    counts.scanned++;
    if (!isGatewayAnthropicUserProfile(profile) || !isOldEnough(profile, cutoff.getTime())) {
      continue;
    }
    counts.candidates++;
    batch.push(profile);
    if (batch.length >= BATCH_SIZE) {
      await processBatch(batch);
      batch = [];
      if (deletedCount() >= maxDeletions) break;
    }
  }
  if (batch.length > 0 && deletedCount() < maxDeletions) await processBatch(batch);

  const pruned = await db
    .delete(anthropic_user_profile_deletions)
    .where(lt(anthropic_user_profile_deletions.deleted_at, cutoff.toISOString()))
    .returning({ id: anthropic_user_profile_deletions.id });
  counts.prunedLogs = pruned.length;

  return { skipped: false, ...counts };
}
