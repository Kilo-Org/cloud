import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq, like } from 'drizzle-orm';
import type { UserProfile } from '@anthropic-ai/sdk/resources/user-profiles/user-profiles';
import {
  anthropic_user_profile_cleanup_state,
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
  listAnthropicUserProfilesPage: jest.fn(),
  deleteAnthropicUserProfile: jest.fn(),
  isGatewayAnthropicUserProfile: (profile: UserProfile) =>
    profile.access_type === 'passthrough' && profile.metadata.kilo_source === 'ai_gateway',
}));

import { captureException } from '@sentry/nextjs';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import {
  deleteAnthropicUserProfile,
  listAnthropicUserProfilesPage,
} from '@kilocode/web-shared/lib/ai-gateway/anthropic-user-profiles/api';
import { runAnthropicUserProfileCleanup } from './cleanup';

const mockList = jest.mocked(listAnthropicUserProfilesPage);
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
    created_at: daysAgo(60).toISOString(),
    updated_at: daysAgo(60).toISOString(),
    ...overrides,
  } as UserProfile;
}

function listsProfiles(...profiles: UserProfile[]) {
  mockList.mockResolvedValue({ profiles, nextPage: null });
}

async function savedNextPage() {
  const [state] = await db.select().from(anthropic_user_profile_cleanup_state);
  return state?.next_page ?? null;
}

async function userProfileOf(userId: string) {
  const [row] = await db
    .select({ id: kilocode_users.anthropic_user_profile_id })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId));
  return row?.id;
}

async function deletionLogs() {
  return await db
    .select()
    .from(anthropic_user_profile_deletions)
    .where(like(anthropic_user_profile_deletions.user_profile_id, `${PREFIX}%`));
}

describe('runAnthropicUserProfileCleanup', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockConfigured.mockReturnValue(true);
    mockDelete.mockResolvedValue(undefined);
    await db
      .delete(anthropic_user_profile_cleanup_state)
      .where(eq(anthropic_user_profile_cleanup_state.id, 1));
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
    await db
      .delete(anthropic_user_profile_cleanup_state)
      .where(eq(anthropic_user_profile_cleanup_state.id, 1));
  });

  it('skips when the operator is not configured', async () => {
    mockConfigured.mockReturnValue(false);

    await expect(runAnthropicUserProfileCleanup({ now: NOW })).resolves.toEqual({ skipped: true });
    expect(mockList).not.toHaveBeenCalled();
  });

  it('keeps profiles created or updated within 30 days', async () => {
    listsProfiles(
      makeProfile({ id: profileId(), created_at: daysAgo(29).toISOString() }),
      makeProfile({ id: profileId(), updated_at: daysAgo(29).toISOString() })
    );

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ scanned: 2, candidates: 0, completedPass: true });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('ignores profiles this feature did not create', async () => {
    listsProfiles(
      makeProfile({ id: profileId(), access_type: 'application' }),
      makeProfile({ id: profileId(), metadata: {} })
    );

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ scanned: 2, candidates: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('queues, deletes and logs an unlinked profile', async () => {
    const id = profileId();
    const profile = makeProfile({ id });
    listsProfiles(profile);

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ queuedUnlinked: 1, deleted: 1, failed: 0 });
    expect(mockDelete).toHaveBeenCalledWith(id);
    const logs = await deletionLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      user_profile_id: id,
      reason: 'unlinked',
      kilo_user_id: null,
      attempt_count: 1,
    });
    expect(logs[0].deleted_at).not.toBeNull();
    expect(new Date(logs[0].profile_created_at ?? '').toISOString()).toBe(profile.created_at);
  });

  it('detaches and deletes the profile of a user blocked for 30 days', async () => {
    const id = profileId();
    const user = await insertTestUser({
      anthropic_user_profile_id: id,
      blocked_at: daysAgo(30).toISOString(),
      blocked_reason: 'abuse',
    });
    listsProfiles(makeProfile({ id }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ queuedUserBlocked: 1, deleted: 1 });
    expect(await userProfileOf(user.id)).toBeNull();
    expect(await deletionLogs()).toMatchObject([
      { user_profile_id: id, reason: 'user_blocked', kilo_user_id: user.id },
    ]);
  });

  it('keeps the profile of a user blocked for less than 30 days', async () => {
    const id = profileId();
    const user = await insertTestUser({
      anthropic_user_profile_id: id,
      blocked_at: daysAgo(29).toISOString(),
      blocked_reason: 'abuse',
    });
    listsProfiles(makeProfile({ id }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ candidates: 0, queuedUserBlocked: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(await userProfileOf(user.id)).toBe(id);
  });

  it('keeps a profile when any referencing user is not blocked', async () => {
    const id = profileId();
    await insertTestUser({ anthropic_user_profile_id: id, blocked_at: daysAgo(60).toISOString() });
    await insertTestUser({ anthropic_user_profile_id: id });
    listsProfiles(makeProfile({ id }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ candidates: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('keeps a profile a live organization references, even when its users are blocked', async () => {
    const id = profileId();
    const owner = await insertTestUser({
      anthropic_user_profile_id: id,
      blocked_at: daysAgo(60).toISOString(),
    });
    const organization = await createTestOrganization('Cleanup Org', owner.id, 0);
    await db
      .update(organizations)
      .set({ anthropic_user_profile_id: id })
      .where(eq(organizations.id, organization.id));
    listsProfiles(makeProfile({ id }));

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ candidates: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(await userProfileOf(owner.id)).toBe(id);
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

    expect(counts).toMatchObject({ queuedUnlinked: 1 });
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

    expect(counts).toMatchObject({ candidates: 0, queuedUnlinked: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('keeps a failed delete queued with the profile detached, and retries it on the next run', async () => {
    const failing = profileId();
    const succeeding = profileId();
    const user = await insertTestUser({
      anthropic_user_profile_id: failing,
      blocked_at: daysAgo(60).toISOString(),
    });
    const error = new Error('Anthropic unavailable');
    mockDelete.mockImplementation(async id => {
      if (id === failing) throw error;
    });
    listsProfiles(makeProfile({ id: failing }), makeProfile({ id: succeeding }));

    const first = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(first).toMatchObject({ failed: 1, deleted: 1, queuedUserBlocked: 1, queuedUnlinked: 1 });
    expect(mockCaptureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ extra: { userProfileId: failing } })
    );
    // The account no longer carries an ID that Anthropic may delete at any moment.
    expect(await userProfileOf(user.id)).toBeNull();
    const pending = (await deletionLogs()).find(log => log.user_profile_id === failing);
    expect(pending).toMatchObject({ attempt_count: 1, deleted_at: null });

    // The retry does not depend on Anthropic still listing the profile.
    mockDelete.mockResolvedValue(undefined);
    listsProfiles();
    const second = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(second).toMatchObject({ deleted: 1, failed: 0 });
    const retried = (await deletionLogs()).find(log => log.user_profile_id === failing);
    expect(retried).toMatchObject({ attempt_count: 2 });
    expect(retried?.deleted_at).not.toBeNull();
  });

  it('caps queued deletions per run and rescans the unfinished page next run', async () => {
    const ids = [profileId(), profileId(), profileId()];
    const page = { profiles: ids.map(id => makeProfile({ id })), nextPage: 'page-2' };
    mockList
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ profiles: [], nextPage: null });

    const first = await runAnthropicUserProfileCleanup({ now: NOW, maxQueued: 2 });

    expect(first).toMatchObject({ queuedUnlinked: 2, deleted: 2, completedPass: false });
    expect(await savedNextPage()).toBeNull();

    const second = await runAnthropicUserProfileCleanup({ now: NOW, maxQueued: 2 });

    expect(second).toMatchObject({ candidates: 1, queuedUnlinked: 1, completedPass: true });
    expect(mockList.mock.calls).toEqual([[null], [null], ['page-2']]);
  });

  it('follows the page cursor and starts over after the last page', async () => {
    const [first, second] = [profileId(), profileId()];
    mockList
      .mockResolvedValueOnce({ profiles: [makeProfile({ id: first })], nextPage: 'page-2' })
      .mockResolvedValueOnce({ profiles: [makeProfile({ id: second })], nextPage: null });

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ pages: 2, queuedUnlinked: 2, completedPass: true });
    expect(mockList.mock.calls).toEqual([[null], ['page-2']]);
    expect(await savedNextPage()).toBeNull();
  });

  it('resumes from the saved page', async () => {
    await db.insert(anthropic_user_profile_cleanup_state).values({ id: 1, next_page: 'page-7' });
    listsProfiles();

    await runAnthropicUserProfileCleanup({ now: NOW });

    expect(mockList).toHaveBeenCalledWith('page-7');
  });

  it('ends the pass at the first profile created after the cutoff', async () => {
    mockList.mockResolvedValue({
      profiles: [makeProfile({ id: profileId(), created_at: daysAgo(1).toISOString() })],
      nextPage: 'page-2',
    });

    const counts = await runAnthropicUserProfileCleanup({ now: NOW });

    expect(counts).toMatchObject({ pages: 1, completedPass: true });
    expect(await savedNextPage()).toBeNull();
  });

  it('stops scanning when the time budget is spent and keeps the saved page', async () => {
    await db.insert(anthropic_user_profile_cleanup_state).values({ id: 1, next_page: 'page-3' });

    const counts = await runAnthropicUserProfileCleanup({ now: NOW, budgetMs: 0 });

    expect(counts).toMatchObject({ pages: 0, deleted: 0 });
    expect(mockList).not.toHaveBeenCalled();
    expect(await savedNextPage()).toBe('page-3');
  });

  it('prunes completed deletions older than seven days but keeps pending ones', async () => {
    const [oldId, recentId, pendingId] = [profileId(), profileId(), profileId()];
    mockDelete.mockRejectedValue(new Error('still unavailable'));
    await db.insert(anthropic_user_profile_deletions).values([
      { user_profile_id: oldId, reason: 'unlinked', deleted_at: daysAgo(8).toISOString() },
      { user_profile_id: recentId, reason: 'unlinked', deleted_at: daysAgo(6).toISOString() },
      { user_profile_id: pendingId, reason: 'unlinked', queued_at: daysAgo(60).toISOString() },
    ]);
    listsProfiles();

    await runAnthropicUserProfileCleanup({ now: NOW });

    const remaining = (await deletionLogs()).map(log => log.user_profile_id).sort();
    expect(remaining).toEqual([recentId, pendingId].sort());
  });
});
