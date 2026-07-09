import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

let testUser: User;

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

describe('user router - customer source', () => {
  it('saves a submitted source', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await caller.user.submitCustomerSource({ source: '  GitHub  ' });

    const updated = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, user.id),
    });
    expect(updated?.customer_source).toBe('GitHub');
  });

  it('rejects empty and oversized sources', async () => {
    const user = await insertTestUser();
    const caller = await createCallerForUser(user.id);

    await expect(caller.user.submitCustomerSource({ source: '   ' })).rejects.toThrow();
    await expect(caller.user.submitCustomerSource({ source: 'a'.repeat(1001) })).rejects.toThrow();
  });

  it('dismisses an unanswered prompt without overwriting an answer', async () => {
    const unansweredUser = await insertTestUser();
    const answeredUser = await insertTestUser({ customer_source: 'A teammate' });

    await (await createCallerForUser(unansweredUser.id)).user.skipCustomerSource();
    await (await createCallerForUser(answeredUser.id)).user.skipCustomerSource();

    const [unansweredResult, answeredResult] = await Promise.all([
      db.query.kilocode_users.findFirst({ where: eq(kilocode_users.id, unansweredUser.id) }),
      db.query.kilocode_users.findFirst({ where: eq(kilocode_users.id, answeredUser.id) }),
    ]);
    expect(unansweredResult?.customer_source).toBe('');
    expect(answeredResult?.customer_source).toBe('A teammate');
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
