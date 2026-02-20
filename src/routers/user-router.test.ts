import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@/db/schema';

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
