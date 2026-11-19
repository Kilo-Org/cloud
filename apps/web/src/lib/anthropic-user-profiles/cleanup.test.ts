import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq, like } from 'drizzle-orm';
import type { UserProfile } from '@anthropic-ai/sdk/resources/user-profiles/user-profiles';
import {
  anthropic_user_profile_deletions,
  claude_billing_connections,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/ai-gateway/claude-billing/operator', () => ({
  isClaudeOperatorConfigured: jest.fn(() => true),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/api', () => ({
  listAnthropicUserProfiles: jest.fn(),
  deleteAnthropicUserProfile: jest.fn(),
  isGatewayAnthropicUserProfile: (profile: UserProfile) =>
    profile.access_type === 'passthrough' && profile.metadata.kilo_source === 'ai_gateway',
}));

import { captureException } from '@sentry/nextjs';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import {
  deleteAnthropicUserProfile,
  listAnthropicUserProfiles,
} from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/api';
import { runAnthropicUserProfileCleanup } from './cleanup';

const mockList = jest.mocked(listAnthropicUserProfiles);
const mockDelete = jest.mocked(deleteAnthropicUserProfile);
const mockConfigured = jest.mocked(isClaudeOperatorConfigured);
const mockCaptureException = jest.mocked(captureException);

const NOW = new Date('2026-06-30T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const PREFIX = `uprof_cleanup_${Math.random().toString(36).slice(2)}_`;
let counter = 0;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function profileId(): string {
  return `${PREFIX}${counter++}`;
}

function makeProfile(overrides: Partial<UserProfile> & { id: string }): UserProfile {
  return {
    type: 'user_profile',
    access_type: 'passthrough',
    metadata: { kilo_source: 'ai_gateway' },
    created_at: daysAgo(30).toISOString(),
    updated_at: daysAgo(30).toISOString(),
    ...overrides,
  } as UserProfile;
}

function listsProfiles(...profiles: UserProfile[]) {
  mockList.mockImplementation(async function* () {
    yield* profiles;
  });
}

async function deletionLogs() {
  return await db
    .select()
    .from(anthropic_user_profile_deletions)
    .where(like(anthropic_user_profile_deletions.user_profile_id, `${PREFIX}%`));
}

describe('runAnthropicUserProfileCleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigured.mockReturnValue(true);
    mockDelete.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await db
      .delete(anthropic_user_profile_deletions)
      .where(like(anthropic_user_profile_deletions.user_profile_id, `${PREFIX}%`));
    await db
      .delete(claude_billing_connections)
      .where(like(claude_billing_connections.user_profile_id, `${PREFIX}%`));
    await db
      .delete(kilocode_users)
      .where(like(kilocode_users.anthropic_user_profile_id, `${PREFIX}%`));
    await db
      .delete(organizations)
      .where(like(organizations.anthropic_user_profile_id, `${PREFIX}%`));
  });

  it('skips when the operator is not configured', async () => {
    mockConfigured.mockReturnValue(false);

    await expect(runAnthropicUserProfileCleanup({ now: NOW })).resolves.toEqual({ skipped: true });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('keeps profiles created or updated within seven days', async () => {
    const recentlyCreated = profileId();
    const recentlyUpdated = profileId();
    listsProfiles(
      makeProfile({ id: recentlyCreated, created_at: daysAgo(6).toISOString() }),
      makeProfile({ id: recentlyUpdated, updated_at: daysAgo(6).toISOString() })
    );

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ scanned: 2, candidates: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('ignores profiles this feature did not create', async () => {
    const foreign = profileId();
    const passthroughWithoutMarker = profileId();
    listsProfiles(
      makeProfile({ id: foreign, access_type: 'standard' as UserProfile['access_type'] }),
      makeProfile({ id: passthroughWithoutMarker, metadata: {} })
    );

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ scanned: 2, candidates: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes and logs an unlinked profile', async () => {
    const id = profileId();
    const profile = makeProfile({ id });
    listsProfiles(profile);

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ deletedUnlinked: 1, deletedUserBlocked: 0, failed: 0 });
    expect(mockDelete).toHaveBeenCalledWith(id);
    const logs = await deletionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      user_profile_id: id,
      reason: 'unlinked',
      kilo_user_id: null,
    });
    expect(new Date(logs[0].profile_created_at ?? '').toISOString()).toBe(profile.created_at);
    expect(new Date(logs[0].profile_updated_at ?? '').toISOString()).toBe(profile.updated_at);
  });

  it('deletes a profile of a user blocked for seven days, clears the link, and logs it', async () => {
    const id = profileId();
    const user = await insertTestUser({
      anthropic_user_profile_id: id,
      blocked_at: daysAgo(7).toISOString(),
      blocked_reason: 'abuse',
    });
    listsProfiles(makeProfile({ id }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ deletedUserBlocked: 1, deletedUnlinked: 0 });
    expect(mockDelete).toHaveBeenCalledWith(id);
    const [updated] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
    expect(updated.anthropic_user_profile_id).toBeNull();
    expect(await deletionLogs()).toMatchObject([
      { user_profile_id: id, reason: 'user_blocked', kilo_user_id: user.id },
    ]);
  });

  it('keeps a profile of a user blocked for less than seven days', async () => {
    const id = profileId();
    const user = await insertTestUser({
      anthropic_user_profile_id: id,
      blocked_at: daysAgo(6).toISOString(),
      blocked_reason: 'abuse',
    });
    listsProfiles(makeProfile({ id }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ candidates: 1, kept: 1, deletedUserBlocked: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
    const [unchanged] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(unchanged.anthropic_user_profile_id).toBe(id);
  });

  it('keeps a profile when any referencing user is not blocked', async () => {
    const id = profileId();
    await insertTestUser({ anthropic_user_profile_id: id, blocked_at: daysAgo(30).toISOString() });
    await insertTestUser({ anthropic_user_profile_id: id });
    listsProfiles(makeProfile({ id }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ kept: 1 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('keeps a profile a live organization references, even when its users are blocked', async () => {
    const id = profileId();
    const owner = await insertTestUser({
      anthropic_user_profile_id: id,
      blocked_at: daysAgo(30).toISOString(),
    });
    const organization = await createTestOrganization('Cleanup Org', owner.id, 0);
    await db
      .update(organizations)
      .set({ anthropic_user_profile_id: id })
      .where(eq(organizations.id, organization.id));
    listsProfiles(makeProfile({ id }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ kept: 1 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('treats a profile only a deleted organization references as unlinked', async () => {
    const id = profileId();
    const owner = await insertTestUser();
    const organization = await createTestOrganization('Deleted Cleanup Org', owner.id, 0);
    await db
      .update(organizations)
      .set({ anthropic_user_profile_id: id, deleted_at: daysAgo(1).toISOString() })
      .where(eq(organizations.id, organization.id));
    listsProfiles(makeProfile({ id }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ deletedUnlinked: 1 });
    expect(await deletionLogs()).toMatchObject([{ user_profile_id: id, reason: 'unlinked' }]);
  });

  it('never deletes a Claude billing profile', async () => {
    const id = profileId();
    const user = await insertTestUser();
    await db.insert(claude_billing_connections).values({
      kilo_user_id: user.id,
      user_profile_id: id,
      created_by: user.id,
    });
    listsProfiles(makeProfile({ id }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ kept: 1, deletedUnlinked: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('continues after a delete failure and does not log or unlink the failed profile', async () => {
    const failing = profileId();
    const succeeding = profileId();
    const user = await insertTestUser({
      anthropic_user_profile_id: failing,
      blocked_at: daysAgo(30).toISOString(),
    });
    const error = new Error('Anthropic unavailable');
    mockDelete.mockImplementation(async id => {
      if (id === failing) throw error;
    });
    listsProfiles(makeProfile({ id: failing }), makeProfile({ id: succeeding }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ failed: 1, deletedUnlinked: 1, deletedUserBlocked: 0 });
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ extra: { userProfileId: failing } })
    );
    expect(await deletionLogs()).toMatchObject([{ user_profile_id: succeeding }]);
    const [unchanged] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(unchanged.anthropic_user_profile_id).toBe(failing);
  });

  it('caps deletions per run', async () => {
    listsProfiles(
      makeProfile({ id: profileId() }),
      makeProfile({ id: profileId() }),
      makeProfile({ id: profileId() })
    );

    const counts = await runAnthropicUserProfileCleanup({ now: NOW, maxDeletions: 2 });

    expect(counts).toMatchObject({ deletedUnlinked: 2 });
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it('prunes deletion logs older than seven days', async () => {
    const oldId = profileId();
    const recentId = profileId();
    await db.insert(anthropic_user_profile_deletions).values([
      { user_profile_id: oldId, reason: 'unlinked', deleted_at: daysAgo(8).toISOString() },
      { user_profile_id: recentId, reason: 'unlinked', deleted_at: daysAgo(6).toISOString() },
    ]);
    listsProfiles();

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ prunedLogs: expect.any(Number) });
    expect(await deletionLogs()).toMatchObject([{ user_profile_id: recentId }]);
  });
});
