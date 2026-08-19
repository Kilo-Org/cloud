import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import {
  credit_transactions,
  device_sessions,
  kilocode_users,
  magic_link_tokens,
  user_notification_preferences,
  user_push_tokens,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { sendSignInCodeEmail } from '@/lib/email';
import { performGdprRemoval } from '@/lib/user/gdpr-removal';
import { assertUserCanBeSoftDeleted, SoftDeletePreconditionError } from '@/lib/user';

jest.mock('@/lib/email', () => {
  const actual = jest.requireActual('@/lib/email');
  return {
    ...actual,
    sendSignInCodeEmail: jest.fn(),
  };
});

jest.mock('@/lib/user/gdpr-removal', () => ({
  performGdprRemoval: jest.fn(),
}));

jest.mock('@/lib/user', () => {
  const actual = jest.requireActual('@/lib/user');
  return {
    ...actual,
    assertUserCanBeSoftDeleted: jest.fn(),
  };
});

const mockSendSignInCodeEmail = jest.mocked(sendSignInCodeEmail);
const mockPerformGdprRemoval = jest.mocked(performGdprRemoval);
const mockAssertUserCanBeSoftDeleted = jest.mocked(assertUserCanBeSoftDeleted);

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

describe('user router - credit purchase history', () => {
  let purchaser: User;
  let otherUser: User;
  const manualPurchaseId = crypto.randomUUID();
  const automaticPurchaseId = crypto.randomUUID();

  beforeAll(async () => {
    purchaser = await insertTestUser({
      total_microdollars_acquired: 35_000_000,
      microdollars_used: 35_000_000,
    });
    otherUser = await insertTestUser();

    await db.insert(credit_transactions).values([
      {
        id: manualPurchaseId,
        kilo_user_id: purchaser.id,
        amount_microdollars: 20_000_000,
        is_free: false,
        description: 'Top-up via stripe',
        stripe_payment_id: `ch_${crypto.randomUUID()}`,
        created_at: '2026-06-20T10:00:00.000Z',
      },
      {
        id: automaticPurchaseId,
        kilo_user_id: purchaser.id,
        amount_microdollars: 15_000_000,
        is_free: false,
        description: 'Auto top-up via stripe',
        stripe_payment_id: `in_${crypto.randomUUID()}`,
        created_at: '2026-06-21T10:00:00.000Z',
      },
      {
        id: crypto.randomUUID(),
        kilo_user_id: purchaser.id,
        amount_microdollars: 9_000_000,
        is_free: false,
        description: 'KiloClaw standard settlement',
        stripe_payment_id: `in_${crypto.randomUUID()}`,
        created_at: '2026-06-22T10:00:00.000Z',
      },
      {
        id: crypto.randomUUID(),
        kilo_user_id: purchaser.id,
        amount_microdollars: 5_000_000,
        is_free: true,
        description: 'Promotional credits',
        created_at: '2026-06-23T10:00:00.000Z',
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(credit_transactions)
      .where(inArray(credit_transactions.kilo_user_id, [purchaser.id, otherUser.id]));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, [purchaser.id, otherUser.id]));
  });

  it('returns spent personal top-ups without subscription deposits or free grants', async () => {
    const caller = await createCallerForUser(purchaser.id);

    const result = await caller.user.getCreditPurchaseHistory({ cursor: 0 });

    expect(result.entries).toEqual([
      expect.objectContaining({
        id: automaticPurchaseId,
        description: 'Automatic top-up',
        amount_mUsd: 15_000_000,
      }),
      expect.objectContaining({
        id: manualPurchaseId,
        description: 'Credit purchase',
        amount_mUsd: 20_000_000,
      }),
    ]);
    expect(result.nextCursor).toBeNull();
    expect(result.previousCursor).toBeNull();
  });

  it('returns confirmation only to the purchaser', async () => {
    const purchaserCaller = await createCallerForUser(purchaser.id);
    const otherCaller = await createCallerForUser(otherUser.id);

    await expect(
      purchaserCaller.user.getCreditPurchaseConfirmation({ transactionId: manualPurchaseId })
    ).resolves.toEqual({
      transactionId: manualPurchaseId,
      amount_mUsd: 20_000_000,
      purchasedAt: '2026-06-20T10:00:00.000Z',
    });
    await expect(
      otherCaller.user.getCreditPurchaseConfirmation({ transactionId: manualPurchaseId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('authorizes receipt lookup by purchase ownership', async () => {
    const purchaserCaller = await createCallerForUser(purchaser.id);
    const otherCaller = await createCallerForUser(otherUser.id);

    await expect(
      purchaserCaller.user.getCreditPurchaseReceipt({ transactionId: manualPurchaseId })
    ).resolves.toEqual({ url: null });
    await expect(
      otherCaller.user.getCreditPurchaseReceipt({ transactionId: manualPurchaseId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('user router - notification preferences', () => {
  let firstUser: User;
  let secondUser: User;

  beforeAll(async () => {
    firstUser = await insertTestUser({
      google_user_email: 'notif-prefs-first@example.com',
      google_user_name: 'Notif Prefs First',
    });
    secondUser = await insertTestUser({
      google_user_email: 'notif-prefs-second@example.com',
      google_user_name: 'Notif Prefs Second',
    });
  });

  afterEach(async () => {
    // Reset notification preferences between tests so order does not matter
    // and per-test assertions about the "no row" default and column-level
    // writes are deterministic.
    await db
      .delete(user_notification_preferences)
      .where(inArray(user_notification_preferences.user_id, [firstUser.id, secondUser.id]));
  });

  afterAll(async () => {
    await db
      .delete(kilocode_users)
      .where(inArray(kilocode_users.id, [firstUser.id, secondUser.id]));
  });

  it('returns the default-on preferences for a user with no row', async () => {
    const caller = await createCallerForUser(firstUser.id);

    const result = await caller.user.getNotificationPreferences();

    expect(result).toEqual({
      chatMessages: true,
      agentAttention: true,
      agentUpdates: true,
      sessionStatus: true,
      kiloclawActivity: true,
      balanceAlerts: true,
      securityFindings: true,
      notificationPreviews: 'generic',
      agentPushEnabled: true,
    });
    // Legacy compat: agentUpdates and agentPushEnabled always share the same value.
    expect(result.agentUpdates).toBe(result.agentPushEnabled);
  });

  it('returns the stored preferences when a row exists', async () => {
    await db.insert(user_notification_preferences).values({
      user_id: firstUser.id,
      agent_push_enabled: false,
      chat_messages_enabled: true,
      agent_attention_enabled: false,
      session_status_enabled: true,
      kiloclaw_activity_enabled: false,
      balance_alerts_enabled: false,
      security_findings_enabled: true,
    });

    const caller = await createCallerForUser(firstUser.id);
    const result = await caller.user.getNotificationPreferences();

    expect(result).toEqual({
      chatMessages: true,
      agentAttention: false,
      agentUpdates: false,
      sessionStatus: true,
      kiloclawActivity: false,
      balanceAlerts: false,
      securityFindings: true,
      notificationPreviews: 'generic',
      agentPushEnabled: false,
    });
    expect(result.agentUpdates).toBe(result.agentPushEnabled);
  });

  it('upserts the preference for the authenticated user only (legacy key)', async () => {
    const caller = await createCallerForUser(firstUser.id);

    const result = await caller.user.setNotificationPreferences({ agentPushEnabled: false });
    expect(result).toEqual({
      chatMessages: true,
      agentAttention: true,
      agentUpdates: false,
      sessionStatus: true,
      kiloclawActivity: true,
      balanceAlerts: true,
      securityFindings: true,
      notificationPreviews: 'generic',
      agentPushEnabled: false,
    });

    const [row] = await db
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, firstUser.id));
    expect(row?.agent_push_enabled).toBe(false);
    // Other columns kept their default (true) since the legacy key only writes agent_push_enabled.
    expect(row?.chat_messages_enabled).toBe(true);
    expect(row?.agent_attention_enabled).toBe(true);
    expect(row?.session_status_enabled).toBe(true);
    expect(row?.kiloclaw_activity_enabled).toBe(true);
    expect(row?.balance_alerts_enabled).toBe(true);
    expect(row?.security_findings_enabled).toBe(true);

    // Calling again with true must update, not insert
    await caller.user.setNotificationPreferences({ agentPushEnabled: true });
    const rows = await db
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, firstUser.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_push_enabled).toBe(true);
  });

  it('isolates preferences per user', async () => {
    const firstCaller = await createCallerForUser(firstUser.id);
    const secondCaller = await createCallerForUser(secondUser.id);

    await firstCaller.user.setNotificationPreferences({ agentPushEnabled: false });
    // Second user has no row; default-on must be returned and the first user's
    // row must not leak.
    const secondPrefs = await secondCaller.user.getNotificationPreferences();
    expect(secondPrefs).toEqual({
      chatMessages: true,
      agentAttention: true,
      agentUpdates: true,
      sessionStatus: true,
      kiloclawActivity: true,
      balanceAlerts: true,
      securityFindings: true,
      notificationPreviews: 'generic',
      agentPushEnabled: true,
    });

    const firstPrefs = await firstCaller.user.getNotificationPreferences();
    expect(firstPrefs).toEqual({
      chatMessages: true,
      agentAttention: true,
      agentUpdates: false,
      sessionStatus: true,
      kiloclawActivity: true,
      balanceAlerts: true,
      securityFindings: true,
      notificationPreviews: 'generic',
      agentPushEnabled: false,
    });

    // Setting second user's preference must not affect first user's row.
    await secondCaller.user.setNotificationPreferences({ agentPushEnabled: false });

    const [firstRow] = await db
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, firstUser.id));
    const [secondRow] = await db
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, secondUser.id));
    expect(firstRow?.agent_push_enabled).toBe(false);
    expect(secondRow?.agent_push_enabled).toBe(false);
  });

  it('writes only the provided column and leaves the others at their prior/default value', async () => {
    const caller = await createCallerForUser(firstUser.id);

    // Set two columns up front, then update only one of them with a new key.
    await caller.user.setNotificationPreferences({
      chatMessages: false,
      sessionStatus: false,
    });

    const result = await caller.user.setNotificationPreferences({ agentAttention: false });
    expect(result).toEqual({
      chatMessages: false,
      agentAttention: false,
      agentUpdates: true,
      sessionStatus: false,
      kiloclawActivity: true,
      balanceAlerts: true,
      securityFindings: true,
      notificationPreviews: 'generic',
      agentPushEnabled: true,
    });

    const [row] = await db
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, firstUser.id));
    // chatMessages and sessionStatus preserved from the prior write.
    expect(row?.chat_messages_enabled).toBe(false);
    expect(row?.session_status_enabled).toBe(false);
    // agentAttention updated.
    expect(row?.agent_attention_enabled).toBe(false);
    // kiloclawActivity and agent_push_enabled still at DB default.
    expect(row?.kiloclaw_activity_enabled).toBe(true);
    expect(row?.agent_push_enabled).toBe(true);
    expect(row?.balance_alerts_enabled).toBe(true);
    expect(row?.security_findings_enabled).toBe(true);
  });

  it('writes only notificationPreviews and leaves the category columns untouched', async () => {
    const caller = await createCallerForUser(firstUser.id);

    const result = await caller.user.setNotificationPreferences({
      notificationPreviews: 'full',
    });

    expect(result.notificationPreviews).toBe('full');
    // All category columns stay at their DB default (true) because only the
    // notificationPreviews key was supplied.
    expect(result.chatMessages).toBe(true);
    expect(result.agentAttention).toBe(true);
    expect(result.agentUpdates).toBe(true);
    expect(result.sessionStatus).toBe(true);
    expect(result.kiloclawActivity).toBe(true);
    expect(result.balanceAlerts).toBe(true);
    expect(result.securityFindings).toBe(true);
    expect(result.agentPushEnabled).toBe(true);

    const [row] = await db
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, firstUser.id));
    expect(row?.notification_previews).toBe('full');
    expect(row?.chat_messages_enabled).toBe(true);
    expect(row?.agent_attention_enabled).toBe(true);
    expect(row?.session_status_enabled).toBe(true);
    expect(row?.kiloclaw_activity_enabled).toBe(true);
    expect(row?.balance_alerts_enabled).toBe(true);
    expect(row?.security_findings_enabled).toBe(true);
    expect(row?.agent_push_enabled).toBe(true);
  });

  it('persists balanceAlerts and securityFindings independently via provided-only upsert', async () => {
    const caller = await createCallerForUser(firstUser.id);

    const afterBalance = await caller.user.setNotificationPreferences({ balanceAlerts: false });
    expect(afterBalance).toEqual({
      chatMessages: true,
      agentAttention: true,
      agentUpdates: true,
      sessionStatus: true,
      kiloclawActivity: true,
      balanceAlerts: false,
      securityFindings: true,
      notificationPreviews: 'generic',
      agentPushEnabled: true,
    });

    const [afterBalanceRow] = await db
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, firstUser.id));
    expect(afterBalanceRow?.balance_alerts_enabled).toBe(false);
    expect(afterBalanceRow?.security_findings_enabled).toBe(true);

    const afterSecurity = await caller.user.setNotificationPreferences({
      securityFindings: false,
    });
    expect(afterSecurity).toEqual({
      chatMessages: true,
      agentAttention: true,
      agentUpdates: true,
      sessionStatus: true,
      kiloclawActivity: true,
      balanceAlerts: false,
      securityFindings: false,
      notificationPreviews: 'generic',
      agentPushEnabled: true,
    });

    const got = await caller.user.getNotificationPreferences();
    expect(got.balanceAlerts).toBe(false);
    expect(got.securityFindings).toBe(false);

    const [row] = await db
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, firstUser.id));
    expect(row?.balance_alerts_enabled).toBe(false);
    expect(row?.security_findings_enabled).toBe(false);
    // Unrelated columns remain at default.
    expect(row?.chat_messages_enabled).toBe(true);
    expect(row?.agent_push_enabled).toBe(true);
  });

  it('accepts the legacy { agentPushEnabled: false } input and reflects agentUpdates === agentPushEnabled === false', async () => {
    // Shipped-client compat path: the legacy key is the only thing the shipped
    // mobile app knows how to send.
    const caller = await createCallerForUser(firstUser.id);

    const result = await caller.user.setNotificationPreferences({ agentPushEnabled: false });
    expect(result.agentUpdates).toBe(false);
    expect(result.agentPushEnabled).toBe(false);
    expect(result.agentUpdates).toBe(result.agentPushEnabled);

    const [row] = await db
      .select()
      .from(user_notification_preferences)
      .where(eq(user_notification_preferences.user_id, firstUser.id));
    expect(row?.agent_push_enabled).toBe(false);
    // Other categories remain at DB default (true) because only the legacy
    // key was supplied.
    expect(row?.chat_messages_enabled).toBe(true);
    expect(row?.agent_attention_enabled).toBe(true);
    expect(row?.session_status_enabled).toBe(true);
    expect(row?.kiloclaw_activity_enabled).toBe(true);
    expect(row?.balance_alerts_enabled).toBe(true);
    expect(row?.security_findings_enabled).toBe(true);
  });
});

describe('user router - register push token', () => {
  let tokenUser: User;

  beforeAll(async () => {
    tokenUser = await insertTestUser({
      google_user_email: 'push-token-register@example.com',
      google_user_name: 'Push Token Register',
    });
  });

  afterEach(async () => {
    await db.delete(user_push_tokens).where(eq(user_push_tokens.user_id, tokenUser.id));
  });

  afterAll(async () => {
    await db.delete(kilocode_users).where(eq(kilocode_users.id, tokenUser.id));
  });

  it('stores the app version when provided', async () => {
    const caller = await createCallerForUser(tokenUser.id);

    await caller.user.registerPushToken({
      token: 'ExponentPushToken[token-with-version]',
      platform: 'android',
      appVersion: '1.0.4',
    });

    const [row] = await db
      .select()
      .from(user_push_tokens)
      .where(eq(user_push_tokens.user_id, tokenUser.id));
    expect(row?.app_version).toBe('1.0.4');
    expect(row?.platform).toBe('android');
  });

  it('stores a null app version when omitted (old client)', async () => {
    const caller = await createCallerForUser(tokenUser.id);

    await caller.user.registerPushToken({
      token: 'ExponentPushToken[token-without-version]',
      platform: 'android',
    });

    const [row] = await db
      .select()
      .from(user_push_tokens)
      .where(eq(user_push_tokens.user_id, tokenUser.id));
    expect(row?.app_version).toBeNull();
  });

  it('updates the app version on re-registration of the same token', async () => {
    const caller = await createCallerForUser(tokenUser.id);
    const token = 'ExponentPushToken[token-re-register]';

    await caller.user.registerPushToken({ token, platform: 'android' });
    await caller.user.registerPushToken({ token, platform: 'android', appVersion: '1.0.4' });

    const rows = await db
      .select()
      .from(user_push_tokens)
      .where(eq(user_push_tokens.user_id, tokenUser.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.app_version).toBe('1.0.4');
  });
});

describe('user router - device sessions', () => {
  let owner: User;
  let otherUser: User;
  let currentSessionId: string;
  let productionShapeSessionId: string;
  let alreadyRevokedSessionId: string;
  let revokeByIdSessionId: string;
  let revokeCurrentSessionId: string;
  let otherOwnedSessionId: string;

  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: `device-sessions-owner-${crypto.randomUUID()}@example.com`,
    });
    otherUser = await insertTestUser({
      google_user_email: `device-sessions-other-${crypto.randomUUID()}@example.com`,
    });

    const [current, productionShape, alreadyRevoked, revokeById, revokeCurrent, otherOwned] =
      await db
        .insert(device_sessions)
        .values([
          {
            kilo_user_id: owner.id,
            user_agent: 'Kilo iOS (current)',
            last_seen_at: '2026-04-30 10:00:00+00',
          },
          {
            kilo_user_id: owner.id,
            user_agent: 'Kilo Android (production shape)',
            created_at: '2026-04-29 01:16:12.945+00',
            last_seen_at: '2026-04-29 01:16:12.945+00',
          },
          {
            kilo_user_id: owner.id,
            user_agent: 'Kilo Desktop (already revoked)',
            revoked_at: '2026-04-27 10:00:00+00',
            revoked_reason: 'user_revoked',
          },
          {
            kilo_user_id: owner.id,
            user_agent: 'Kilo macOS (revoke by id)',
            last_seen_at: '2026-04-26 10:00:00+00',
          },
          {
            kilo_user_id: owner.id,
            user_agent: 'Kilo Tablet (revoke current)',
            last_seen_at: '2026-04-28 10:00:00+00',
          },
          {
            kilo_user_id: otherUser.id,
            user_agent: "Other user's session",
          },
        ])
        .returning();

    currentSessionId = current.id;
    productionShapeSessionId = productionShape.id;
    alreadyRevokedSessionId = alreadyRevoked.id;
    revokeByIdSessionId = revokeById.id;
    revokeCurrentSessionId = revokeCurrent.id;
    otherOwnedSessionId = otherOwned.id;
  });

  afterAll(async () => {
    await db
      .delete(device_sessions)
      .where(inArray(device_sessions.kilo_user_id, [owner.id, otherUser.id]));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, [owner.id, otherUser.id]));
  });

  it('lists active owned sessions ordered by last seen with normalized timestamps and isCurrent', async () => {
    const caller = await createCallerForUser(owner.id, { deviceSessionId: currentSessionId });

    const result = await caller.user.listDeviceSessions();

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      id: currentSessionId,
      user_agent: 'Kilo iOS (current)',
      created_at: expect.any(String),
      last_seen_at: '2026-04-30T10:00:00.000Z',
      isCurrent: true,
    });
    // The row inserted with production-shaped PostgreSQL timestamp text is
    // normalized to strict UTC ISO before it crosses the JSON boundary.
    expect(result[1]).toEqual({
      id: productionShapeSessionId,
      user_agent: 'Kilo Android (production shape)',
      created_at: '2026-04-29T01:16:12.945Z',
      last_seen_at: '2026-04-29T01:16:12.945Z',
      isCurrent: false,
    });
    expect(result[2]).toEqual({
      id: revokeCurrentSessionId,
      user_agent: 'Kilo Tablet (revoke current)',
      created_at: expect.any(String),
      last_seen_at: '2026-04-28T10:00:00.000Z',
      isCurrent: false,
    });
    expect(result[3]).toEqual({
      id: revokeByIdSessionId,
      user_agent: 'Kilo macOS (revoke by id)',
      created_at: expect.any(String),
      last_seen_at: '2026-04-26T10:00:00.000Z',
      isCurrent: false,
    });
    // Revoked sessions and other users' sessions never appear.
    expect(result.some(row => row.id === alreadyRevokedSessionId)).toBe(false);
    expect(result.some(row => row.id === otherOwnedSessionId)).toBe(false);
  });

  it('marks no session as current when the request carries no deviceSessionId claim', async () => {
    const caller = await createCallerForUser(owner.id);

    const result = await caller.user.listDeviceSessions();

    expect(result).toHaveLength(4);
    expect(result.every(row => row.isCurrent === false)).toBe(true);
  });

  it('revokes an owned active session with the user_revoked reason', async () => {
    const caller = await createCallerForUser(owner.id);

    await caller.user.revokeDeviceSessionById({ sessionId: revokeByIdSessionId });

    const [row] = await db
      .select()
      .from(device_sessions)
      .where(eq(device_sessions.id, revokeByIdSessionId));
    expect(row?.revoked_at).not.toBeNull();
    expect(row?.revoked_reason).toBe('user_revoked');
  });

  it('refuses to revoke a session owned by another user', async () => {
    const caller = await createCallerForUser(otherUser.id);

    await caller.user.revokeDeviceSessionById({ sessionId: currentSessionId });

    // The owner's session stays active.
    const [row] = await db
      .select()
      .from(device_sessions)
      .where(eq(device_sessions.id, currentSessionId));
    expect(row?.revoked_at).toBeNull();
  });

  it('rejects a non-UUID session id', async () => {
    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.user.revokeDeviceSessionById({ sessionId: 'not-a-uuid' })
    ).rejects.toThrow();
  });

  it('revokes the current device session with the logout reason', async () => {
    const caller = await createCallerForUser(owner.id, {
      deviceSessionId: revokeCurrentSessionId,
    });

    await caller.user.revokeCurrentDeviceSession();

    const [row] = await db
      .select()
      .from(device_sessions)
      .where(eq(device_sessions.id, revokeCurrentSessionId));
    expect(row?.revoked_at).not.toBeNull();
    expect(row?.revoked_reason).toBe('logout');
  });

  it('is a no-op when the request carries no deviceSessionId claim', async () => {
    const caller = await createCallerForUser(owner.id);

    await expect(caller.user.revokeCurrentDeviceSession()).resolves.toBeDefined();
  });

  it('refuses to revoke the current session when the claim names a session owned by another user', async () => {
    const caller = await createCallerForUser(otherUser.id, {
      deviceSessionId: currentSessionId,
    });

    await caller.user.revokeCurrentDeviceSession();

    const [row] = await db
      .select()
      .from(device_sessions)
      .where(eq(device_sessions.id, currentSessionId));
    expect(row?.revoked_at).toBeNull();
  });
});

describe('user router - account deletion', () => {
  let deletionUser: User;

  beforeEach(async () => {
    deletionUser = await insertTestUser({
      google_user_email: `deletion-${crypto.randomUUID()}@example.com`,
      google_user_name: 'Deletion Test User',
    });

    mockSendSignInCodeEmail.mockReset();
    mockPerformGdprRemoval.mockReset();
    mockAssertUserCanBeSoftDeleted.mockReset();

    mockAssertUserCanBeSoftDeleted.mockResolvedValue(undefined);
    mockPerformGdprRemoval.mockResolvedValue({ warnings: [] });
    mockSendSignInCodeEmail.mockResolvedValue({ sent: false, reason: 'provider_not_configured' });
  });

  afterEach(async () => {
    await db
      .delete(magic_link_tokens)
      .where(eq(magic_link_tokens.email, deletionUser.google_user_email));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, deletionUser.id));
  });

  it('challenge sends the sign-in code email to the authenticated email', async () => {
    const caller = await createCallerForUser(deletionUser.id);

    const result = await caller.user.requestAccountDeletionChallenge();

    expect(mockSendSignInCodeEmail).toHaveBeenCalledTimes(1);
    expect(mockSendSignInCodeEmail).toHaveBeenCalledWith(
      deletionUser.google_user_email,
      expect.any(String)
    );
    expect(result.challengeId).toEqual(expect.any(String));
    expect(result.devCode).toEqual(expect.any(String));
  });

  it('challenge does not accept a client-supplied email', async () => {
    const caller = await createCallerForUser(deletionUser.id);

    await caller.user.requestAccountDeletionChallenge();

    // The mutation takes no input; the only email used is the authenticated
    // user's own address, never a client-provided value.
    expect(mockSendSignInCodeEmail).toHaveBeenCalledWith(
      deletionUser.google_user_email,
      expect.any(String)
    );
  });

  it('challenge returns devCode when the email sends in non-production', async () => {
    mockSendSignInCodeEmail.mockResolvedValue({ sent: true });
    const caller = await createCallerForUser(deletionUser.id);

    const result = await caller.user.requestAccountDeletionChallenge();

    expect(result.challengeId).toEqual(expect.any(String));
    expect(result.devCode).toEqual(expect.any(String));
  });

  it('challenge omits devCode in production', async () => {
    mockSendSignInCodeEmail.mockResolvedValue({ sent: true });
    const caller = await createCallerForUser(deletionUser.id);
    const restoreNodeEnv = jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    try {
      const result = await caller.user.requestAccountDeletionChallenge();

      expect(result.challengeId).toEqual(expect.any(String));
      expect(result.devCode).toBeUndefined();
    } finally {
      restoreNodeEnv.restore();
    }
  });

  it('wrong code does not delete the account', async () => {
    const caller = await createCallerForUser(deletionUser.id);
    const { challengeId, devCode } = await caller.user.requestAccountDeletionChallenge();
    const wrongCode = devCode === '000000' ? '111111' : '000000';

    await expect(
      caller.user.requestAccountDeletion({ challengeId, code: wrongCode })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mockPerformGdprRemoval).not.toHaveBeenCalled();
  });

  it('valid code calls performGdprRemoval once', async () => {
    const caller = await createCallerForUser(deletionUser.id);
    const { challengeId, devCode } = await caller.user.requestAccountDeletionChallenge();

    const result = await caller.user.requestAccountDeletion({
      challengeId,
      code: devCode as string,
    });

    expect(result).toEqual({ status: 'deleted' });
    expect(mockPerformGdprRemoval).toHaveBeenCalledTimes(1);
    expect(mockPerformGdprRemoval).toHaveBeenCalledWith(deletionUser.id, {
      destroyReason: 'admin_request',
      actor: {
        id: deletionUser.id,
        email: deletionUser.google_user_email,
        name: deletionUser.google_user_name,
      },
    });
  });

  it('keeps the code usable when performGdprRemoval fails, so a retry succeeds', async () => {
    mockPerformGdprRemoval.mockRejectedValueOnce(new Error('kiloclaw destroy failed'));
    const caller = await createCallerForUser(deletionUser.id);
    const { challengeId, devCode } = await caller.user.requestAccountDeletionChallenge();

    await expect(
      caller.user.requestAccountDeletion({ challengeId, code: devCode as string })
    ).rejects.toThrow();

    const [afterFailure] = await db
      .select()
      .from(magic_link_tokens)
      .where(eq(magic_link_tokens.challenge_id, challengeId));
    expect(afterFailure?.consumed_at).toBeNull();
    expect(afterFailure?.reserved_until).toBeNull();

    await expect(
      caller.user.requestAccountDeletion({ challengeId, code: devCode as string })
    ).resolves.toEqual({ status: 'deleted' });

    expect(mockPerformGdprRemoval).toHaveBeenCalledTimes(2);

    const [afterRetry] = await db
      .select()
      .from(magic_link_tokens)
      .where(eq(magic_link_tokens.challenge_id, challengeId));
    expect(afterRetry?.consumed_at).not.toBeNull();
  });

  it('rejects a replay of the code after a successful deletion', async () => {
    const caller = await createCallerForUser(deletionUser.id);
    const { challengeId, devCode } = await caller.user.requestAccountDeletionChallenge();

    await caller.user.requestAccountDeletion({ challengeId, code: devCode as string });

    await expect(
      caller.user.requestAccountDeletion({ challengeId, code: devCode as string })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mockPerformGdprRemoval).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired code without deleting', async () => {
    const caller = await createCallerForUser(deletionUser.id);
    const { challengeId, devCode } = await caller.user.requestAccountDeletionChallenge();

    await db
      .update(magic_link_tokens)
      .set({
        // Shift both timestamps into the past so the code is expired while
        // still satisfying the `expires_at > created_at` check constraint.
        created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .where(eq(magic_link_tokens.challenge_id, challengeId));

    await expect(
      caller.user.requestAccountDeletion({ challengeId, code: devCode as string })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mockPerformGdprRemoval).not.toHaveBeenCalled();
  });

  it('wrong code increments attempts and does not delete', async () => {
    const caller = await createCallerForUser(deletionUser.id);
    const { challengeId, devCode } = await caller.user.requestAccountDeletionChallenge();
    const wrongCode = devCode === '000000' ? '111111' : '000000';

    await expect(
      caller.user.requestAccountDeletion({ challengeId, code: wrongCode })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mockPerformGdprRemoval).not.toHaveBeenCalled();

    const [row] = await db
      .select()
      .from(magic_link_tokens)
      .where(eq(magic_link_tokens.challenge_id, challengeId));
    expect(row?.attempts).toBe(1);
  });

  it('maps too_many_attempts to TOO_MANY_REQUESTS', async () => {
    const caller = await createCallerForUser(deletionUser.id);
    const { challengeId, devCode } = await caller.user.requestAccountDeletionChallenge();

    await db
      .update(magic_link_tokens)
      .set({ attempts: 5 })
      .where(eq(magic_link_tokens.challenge_id, challengeId));

    await expect(
      caller.user.requestAccountDeletion({ challengeId, code: devCode as string })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    expect(mockPerformGdprRemoval).not.toHaveBeenCalled();
  });

  it('production provider_not_configured does not stamp and throws INTERNAL_SERVER_ERROR', async () => {
    const caller = await createCallerForUser(deletionUser.id);
    const restoreNodeEnv = jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    try {
      await expect(caller.user.requestAccountDeletionChallenge()).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });

      const [user] = await db
        .select()
        .from(kilocode_users)
        .where(eq(kilocode_users.id, deletionUser.id));
      expect(user?.account_deletion_requested_at).toBeNull();
    } finally {
      restoreNodeEnv.restore();
    }
  });

  it('precondition error maps to PRECONDITION_FAILED without deleting', async () => {
    mockAssertUserCanBeSoftDeleted.mockRejectedValue(
      new SoftDeletePreconditionError('active subscription')
    );
    const caller = await createCallerForUser(deletionUser.id);
    const { challengeId, devCode } = await caller.user.requestAccountDeletionChallenge();

    await expect(
      caller.user.requestAccountDeletion({ challengeId, code: devCode as string })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mockPerformGdprRemoval).not.toHaveBeenCalled();
  });
});
