/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { softDeleteUser } from '@/lib/user';
import { canonicalizeDeletedUserEmail } from '@/lib/user/deleted-email';
import { normalizedEmailBackfillCandidates } from './route';

describe('normalizedEmailBackfillCandidates', () => {
  afterEach(async () => {
    await db.delete(kilocode_users);
  });

  it('includes users that are missing normalized_email', async () => {
    const user = await insertTestUser({ normalized_email: null });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(normalizedEmailBackfillCandidates);

    expect(rows.map(r => r.id)).toContain(user.id);
  });

  it('excludes users that already have normalized_email set', async () => {
    const user = await insertTestUser({ normalized_email: 'user@example.com' });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(normalizedEmailBackfillCandidates);

    expect(rows.map(r => r.id)).not.toContain(user.id);
  });

  it('does not select newly soft-deleted users because their tombstone email is stored', async () => {
    const user = await insertTestUser({ normalized_email: 'user@example.com' });

    await softDeleteUser(user.id);
    const softDeleted = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(softDeleted[0].google_user_email).toBe(`deleted-${user.id}@deleted.invalid`);
    expect(softDeleted[0].normalized_email).toBe(`deleted-${user.id}@deleted.invalid`);
    expect(softDeleted[0].blocked_reason).toMatch(/^soft-deleted at /);

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(normalizedEmailBackfillCandidates);

    expect(rows.map(r => r.id)).not.toContain(user.id);
  });

  it('selects and canonicalizes legacy plus-addressed deletion tombstones', async () => {
    const userId = 'legacy-deleted-user';
    const legacyEmail = `deleted+${userId}@deleted.invalid`;
    const user = await insertTestUser({
      id: userId,
      google_user_email: legacyEmail,
      normalized_email: 'deleted@deleted.invalid',
      blocked_reason: 'soft-deleted at 2026-01-15T12:00:00.000Z',
    });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(normalizedEmailBackfillCandidates);

    expect(rows.map(r => r.id)).toContain(user.id);
    expect(canonicalizeDeletedUserEmail(user.id, legacyEmail)).toBe(
      `deleted-${user.id}@deleted.invalid`
    );
  });

  it('still includes users blocked for other reasons', async () => {
    const user = await insertTestUser({
      normalized_email: null,
      blocked_reason: 'domainblocked',
    });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(normalizedEmailBackfillCandidates);

    expect(rows.map(r => r.id)).toContain(user.id);
  });
});
