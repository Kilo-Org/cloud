/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { softDeleteUser } from '@/lib/user';
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

  it('excludes soft-deleted users so the GDPR normalized_email=null invariant is preserved', async () => {
    const user = await insertTestUser({ normalized_email: 'user@example.com' });

    await softDeleteUser(user.id);
    const softDeleted = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(softDeleted[0].normalized_email).toBeNull();
    expect(softDeleted[0].blocked_reason).toMatch(/^soft-deleted at /);

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(normalizedEmailBackfillCandidates);

    expect(rows.map(r => r.id)).not.toContain(user.id);
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
