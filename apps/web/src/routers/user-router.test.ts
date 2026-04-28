import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import { channel_badge_counts, kilocode_users } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

let testUser: User;
let surveyTestUser: User;
let skipTestUser: User;

describe('user router - updateProfile', () => {
  beforeAll(async () => {
    testUser = await insertTestUser({
      google_user_email: 'update-profile-test@example.com',
      google_user_name: 'Profile Test User',
    });
  });

  afterEach(async () => {
    // Reset profile URLs between tests
    await db
      .update(kilocode_users)
      .set({ linkedin_url: null, github_url: null })
      .where(eq(kilocode_users.id, testUser.id));
  });

  it('updates linkedin_url only', async () => {
    const caller = await createCallerForUser(testUser.id);
    const result = await caller.user.updateProfile({
      linkedin_url: 'https://linkedin.com/in/testuser',
    });

    expect(result).toEqual({ success: true });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, testUser.id),
    });
    expect(updated?.linkedin_url).toBe('https://linkedin.com/in/testuser');
    expect(updated?.github_url).toBeNull();
  });

  it('updates github_url only', async () => {
    const caller = await createCallerForUser(testUser.id);
    const result = await caller.user.updateProfile({
      github_url: 'https://github.com/testuser',
    });

    expect(result).toEqual({ success: true });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, testUser.id),
    });
    expect(updated?.github_url).toBe('https://github.com/testuser');
    expect(updated?.linkedin_url).toBeNull();
  });

  it('updates both fields at once', async () => {
    const caller = await createCallerForUser(testUser.id);
    const result = await caller.user.updateProfile({
      linkedin_url: 'https://linkedin.com/in/testuser',
      github_url: 'https://github.com/testuser',
    });

    expect(result).toEqual({ success: true });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, testUser.id),
    });
    expect(updated?.linkedin_url).toBe('https://linkedin.com/in/testuser');
    expect(updated?.github_url).toBe('https://github.com/testuser');
  });

  it('clears a URL by passing null', async () => {
    // First set a value
    await db
      .update(kilocode_users)
      .set({ linkedin_url: 'https://linkedin.com/in/testuser' })
      .where(eq(kilocode_users.id, testUser.id));

    const caller = await createCallerForUser(testUser.id);
    const result = await caller.user.updateProfile({
      linkedin_url: null,
    });

    expect(result).toEqual({ success: true });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, testUser.id),
    });
    expect(updated?.linkedin_url).toBeNull();
  });

  it('rejects invalid URLs', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.user.updateProfile({
        linkedin_url: 'not-a-url',
      })
    ).rejects.toThrow();

    await expect(
      caller.user.updateProfile({
        github_url: 'just some text',
      })
    ).rejects.toThrow();
  });

  it('rejects javascript: protocol URLs', async () => {
    const caller = await createCallerForUser(testUser.id);

    await expect(
      caller.user.updateProfile({
        linkedin_url: 'javascript:alert(1)',
      })
    ).rejects.toThrow();

    await expect(
      caller.user.updateProfile({
        github_url: 'javascript:void(0)',
      })
    ).rejects.toThrow();
  });

  it('returns success when no fields are provided', async () => {
    const caller = await createCallerForUser(testUser.id);
    const result = await caller.user.updateProfile({});

    expect(result).toEqual({ success: true });
  });
});

describe('user router - submitCustomerSource', () => {
  beforeAll(async () => {
    surveyTestUser = await insertTestUser({
      google_user_email: 'survey-test@example.com',
      google_user_name: 'Survey Test User',
    });
  });

  afterEach(async () => {
    await db
      .update(kilocode_users)
      .set({ customer_source: null })
      .where(eq(kilocode_users.id, surveyTestUser.id));
  });

  it('saves the customer source to the database', async () => {
    const caller = await createCallerForUser(surveyTestUser.id);
    const result = await caller.user.submitCustomerSource({ source: 'A YouTube video' });

    expect(result).toEqual({ success: true });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, surveyTestUser.id),
    });
    expect(updated?.customer_source).toBe('A YouTube video');
  });

  it('overwrites a previous response', async () => {
    const caller = await createCallerForUser(surveyTestUser.id);

    await caller.user.submitCustomerSource({ source: 'First answer' });
    await caller.user.submitCustomerSource({ source: 'Updated answer' });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, surveyTestUser.id),
    });
    expect(updated?.customer_source).toBe('Updated answer');
  });

  it('rejects empty strings', async () => {
    const caller = await createCallerForUser(surveyTestUser.id);

    await expect(caller.user.submitCustomerSource({ source: '' })).rejects.toThrow();
  });

  it('rejects strings over 1000 characters', async () => {
    const caller = await createCallerForUser(surveyTestUser.id);

    const longString = 'a'.repeat(1001);
    await expect(caller.user.submitCustomerSource({ source: longString })).rejects.toThrow();
  });

  it('accepts a string at the max length of 1000', async () => {
    const caller = await createCallerForUser(surveyTestUser.id);
    const maxString = 'a'.repeat(1000);

    const result = await caller.user.submitCustomerSource({ source: maxString });
    expect(result).toEqual({ success: true });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, surveyTestUser.id),
    });
    expect(updated?.customer_source).toBe(maxString);
  });

  it('accepts a single-character string', async () => {
    const caller = await createCallerForUser(surveyTestUser.id);
    const result = await caller.user.submitCustomerSource({ source: 'X' });

    expect(result).toEqual({ success: true });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, surveyTestUser.id),
    });
    expect(updated?.customer_source).toBe('X');
  });

  it('accepts 1000 chars of content with leading/trailing spaces (validates post-trim)', async () => {
    const caller = await createCallerForUser(surveyTestUser.id);
    const content = 'a'.repeat(1000);
    const result = await caller.user.submitCustomerSource({ source: `  ${content}  ` });

    expect(result).toEqual({ success: true });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, surveyTestUser.id),
    });
    expect(updated?.customer_source).toBe(content);
  });

  describe('whitespace-only input rejection', () => {
    it('rejects spaces-only input', async () => {
      const caller = await createCallerForUser(surveyTestUser.id);

      await expect(caller.user.submitCustomerSource({ source: '   ' })).rejects.toThrow();
    });

    it('rejects tab-only input', async () => {
      const caller = await createCallerForUser(surveyTestUser.id);

      await expect(caller.user.submitCustomerSource({ source: '\t\t' })).rejects.toThrow();
    });

    it('rejects newline-only input', async () => {
      const caller = await createCallerForUser(surveyTestUser.id);

      await expect(caller.user.submitCustomerSource({ source: '\n\n' })).rejects.toThrow();
    });

    it('rejects mixed whitespace input', async () => {
      const caller = await createCallerForUser(surveyTestUser.id);

      await expect(caller.user.submitCustomerSource({ source: ' \t\n ' })).rejects.toThrow();
    });
  });

  describe('whitespace trimming on valid input', () => {
    it('trims leading and trailing whitespace before storing', async () => {
      const caller = await createCallerForUser(surveyTestUser.id);
      const result = await caller.user.submitCustomerSource({ source: '  hello  ' });

      expect(result).toEqual({ success: true });

      const updated = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, surveyTestUser.id),
      });
      expect(updated?.customer_source).toBe('hello');
    });

    it('preserves internal whitespace in stored value', async () => {
      const caller = await createCallerForUser(surveyTestUser.id);
      const result = await caller.user.submitCustomerSource({ source: 'a YouTube video' });

      expect(result).toEqual({ success: true });

      const updated = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, surveyTestUser.id),
      });
      expect(updated?.customer_source).toBe('a YouTube video');
    });
  });
});

describe('user router - skipCustomerSource', () => {
  beforeAll(async () => {
    skipTestUser = await insertTestUser({
      google_user_email: 'skip-survey-test@example.com',
      google_user_name: 'Skip Survey Test User',
    });
  });

  afterEach(async () => {
    await db
      .update(kilocode_users)
      .set({ customer_source: null })
      .where(eq(kilocode_users.id, skipTestUser.id));
  });

  it('skipCustomerSource mutation exists and returns success', async () => {
    const caller = await createCallerForUser(skipTestUser.id);
    const result = await caller.user.skipCustomerSource();

    expect(result).toEqual({ success: true });
  });

  it('sets customer_source to empty string after skipping', async () => {
    const caller = await createCallerForUser(skipTestUser.id);
    await caller.user.skipCustomerSource();

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, skipTestUser.id),
    });
    expect(updated?.customer_source).toBe('');
  });

  it('is idempotent - calling skipCustomerSource twice still returns success', async () => {
    const caller = await createCallerForUser(skipTestUser.id);

    const result1 = await caller.user.skipCustomerSource();
    expect(result1).toEqual({ success: true });

    const result2 = await caller.user.skipCustomerSource();
    expect(result2).toEqual({ success: true });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, skipTestUser.id),
    });
    expect(updated?.customer_source).toBe('');
  });

  it('does NOT overwrite a real answer when skipCustomerSource is called after submitCustomerSource', async () => {
    const caller = await createCallerForUser(skipTestUser.id);

    await caller.user.submitCustomerSource({ source: 'Found it on Hacker News' });
    await caller.user.skipCustomerSource();

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, skipTestUser.id),
    });
    expect(updated?.customer_source).toBe('Found it on Hacker News');
  });

  it('allows a real answer to overwrite a previous skip', async () => {
    const caller = await createCallerForUser(skipTestUser.id);
    await caller.user.skipCustomerSource();
    await caller.user.submitCustomerSource({ source: 'Changed my mind — Reddit' });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, skipTestUser.id),
    });
    expect(updated?.customer_source).toBe('Changed my mind — Reddit');
  });
});

describe('session and API token reset mutations', () => {
  async function findRequiredUser(userId: string): Promise<User> {
    const user = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, userId),
    });
    if (!user) throw new Error(`Expected test user to exist: ${userId}`);
    return user;
  }

  it('resets the current user API key without signing out browser sessions', async () => {
    const user = await insertTestUser({
      api_token_pepper: 'api-pepper-before',
      web_session_pepper: 'web-session-pepper-before',
    });
    const caller = await createCallerForUser(user.id);

    await caller.user.resetAPIKey();

    const updated = await findRequiredUser(user.id);
    expect(updated.api_token_pepper).toEqual(expect.any(String));
    expect(updated.api_token_pepper).not.toBe('api-pepper-before');
    expect(updated.web_session_pepper).toBe('web-session-pepper-before');
  });

  it('signs out current user browser sessions without resetting the API key', async () => {
    const user = await insertTestUser({
      api_token_pepper: 'api-pepper-before',
      web_session_pepper: 'web-session-pepper-before',
    });
    const caller = await createCallerForUser(user.id);

    await caller.user.signOutBrowserSessions();

    const updated = await findRequiredUser(user.id);
    expect(updated.web_session_pepper).toEqual(expect.any(String));
    expect(updated.web_session_pepper).not.toBe('web-session-pepper-before');
    expect(updated.api_token_pepper).toBe('api-pepper-before');
  });

  it('lets admins reset a user API key without signing out browser sessions', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const target = await insertTestUser({
      api_token_pepper: 'api-pepper-before',
      web_session_pepper: 'web-session-pepper-before',
    });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.users.resetAPIKey({ userId: target.id });

    const updated = await findRequiredUser(target.id);
    expect(updated.api_token_pepper).toEqual(expect.any(String));
    expect(updated.api_token_pepper).not.toBe('api-pepper-before');
    expect(updated.web_session_pepper).toBe('web-session-pepper-before');
  });

  it('lets admins sign out user browser sessions without resetting the API key', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const target = await insertTestUser({
      api_token_pepper: 'api-pepper-before',
      web_session_pepper: 'web-session-pepper-before',
    });
    const caller = await createCallerForUser(admin.id);

    await caller.admin.users.signOutBrowserSessions({ userId: target.id });

    const updated = await findRequiredUser(target.id);
    expect(updated.web_session_pepper).toEqual(expect.any(String));
    expect(updated.web_session_pepper).not.toBe('web-session-pepper-before');
    expect(updated.api_token_pepper).toBe('api-pepper-before');
  });
});

describe('user router - getUnreadCounts', () => {
  async function seedBadge(userId: string, channelId: string, count: number) {
    await db
      .insert(channel_badge_counts)
      .values({ user_id: userId, channel_id: channelId, badge_count: count });
  }

  async function cleanupBadges(userId: string) {
    await db.delete(channel_badge_counts).where(eq(channel_badge_counts.user_id, userId));
  }

  it('returns per-channel unread counts for the current user', async () => {
    const user = await insertTestUser({
      google_user_email: `unread-counts-basic-${crypto.randomUUID()}@example.com`,
    });
    await seedBadge(user.id, 'sandbox-alpha', 3);
    await seedBadge(user.id, 'sandbox-beta', 7);

    const caller = await createCallerForUser(user.id);
    const result = await caller.user.getUnreadCounts();

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        { channelId: 'sandbox-alpha', badgeCount: 3 },
        { channelId: 'sandbox-beta', badgeCount: 7 },
      ])
    );

    await cleanupBadges(user.id);
  });

  it('omits channels with a zero badge count', async () => {
    const user = await insertTestUser({
      google_user_email: `unread-counts-zero-${crypto.randomUUID()}@example.com`,
    });
    await seedBadge(user.id, 'sandbox-has-unread', 2);
    await seedBadge(user.id, 'sandbox-no-unread', 0);

    const caller = await createCallerForUser(user.id);
    const result = await caller.user.getUnreadCounts();

    expect(result).toEqual([{ channelId: 'sandbox-has-unread', badgeCount: 2 }]);

    await cleanupBadges(user.id);
  });

  it('does not return counts from other users', async () => {
    const user = await insertTestUser({
      google_user_email: `unread-counts-me-${crypto.randomUUID()}@example.com`,
    });
    const other = await insertTestUser({
      google_user_email: `unread-counts-other-${crypto.randomUUID()}@example.com`,
    });
    await seedBadge(user.id, 'sandbox-mine', 4);
    await seedBadge(other.id, 'sandbox-theirs', 9);

    const caller = await createCallerForUser(user.id);
    const result = await caller.user.getUnreadCounts();

    expect(result).toEqual([{ channelId: 'sandbox-mine', badgeCount: 4 }]);

    await cleanupBadges(user.id);
    await cleanupBadges(other.id);
  });

  it('reflects a count that was reset via markChatRead', async () => {
    const user = await insertTestUser({
      google_user_email: `unread-counts-after-read-${crypto.randomUUID()}@example.com`,
    });
    await seedBadge(user.id, 'sandbox-read', 5);
    await seedBadge(user.id, 'sandbox-still-unread', 1);

    const caller = await createCallerForUser(user.id);
    await caller.user.markChatRead({ channelId: 'sandbox-read' });

    const result = await caller.user.getUnreadCounts();

    expect(result).toEqual([{ channelId: 'sandbox-still-unread', badgeCount: 1 }]);

    // Defensive: confirm the row was zeroed, not deleted.
    const zeroed = await db
      .select({ count: channel_badge_counts.badge_count })
      .from(channel_badge_counts)
      .where(
        and(
          eq(channel_badge_counts.user_id, user.id),
          eq(channel_badge_counts.channel_id, 'sandbox-read')
        )
      );
    expect(zeroed).toEqual([{ count: 0 }]);

    await cleanupBadges(user.id);
  });
});
