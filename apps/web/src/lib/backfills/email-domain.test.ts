/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { softDeleteUser } from '@/lib/user';
import { backfillEmailDomainBatch, emailDomainBackfillCandidates } from './email-domain';

describe('emailDomainBackfillCandidates', () => {
  afterEach(async () => {
    await db.delete(kilocode_users);
  });

  it('includes users that are missing email_domain', async () => {
    const user = await insertTestUser({ email_domain: null });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).toContain(user.id);
  });

  it('excludes users that already have email_domain set', async () => {
    const user = await insertTestUser({ email_domain: 'example.com' });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).not.toContain(user.id);
  });

  it('excludes soft-deleted users so the GDPR email_domain=null invariant is preserved', async () => {
    const user = await insertTestUser({ email_domain: 'example.com' });

    await softDeleteUser(user.id);
    const softDeleted = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(softDeleted[0].email_domain).toBeNull();
    expect(softDeleted[0].blocked_reason).toMatch(/^soft-deleted at /);

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).not.toContain(user.id);
  });

  it('excludes deletion-in-progress users so backfill does not race with deletion', async () => {
    const user = await insertTestUser({
      email_domain: null,
      blocked_reason: 'deletion-in-progress at 2026-08-11T12:00:00.000Z',
    });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).not.toContain(user.id);
  });

  it('still includes users blocked for other reasons', async () => {
    const user = await insertTestUser({
      email_domain: null,
      blocked_reason: 'domainblocked',
    });

    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates);

    expect(rows.map(r => r.id)).toContain(user.id);
  });
});

describe('backfillEmailDomainBatch', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.delete(kilocode_users);
  });

  it('fills missing email domains', async () => {
    const user = await insertTestUser({
      google_user_email: 'someone@mail.example.co.uk',
      email_domain: null,
    });

    await expect(backfillEmailDomainBatch()).resolves.toEqual({ processed: 1, remaining: false });

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
    expect(row.email_domain).toBe('example.co.uk');
  });

  it('does not write a domain onto a row soft-deleted after the select', async () => {
    const user = await insertTestUser({
      google_user_email: 'someone@example.com',
      email_domain: null,
    });
    const execute = db.execute.bind(db);
    jest.spyOn(db, 'execute').mockImplementationOnce((async (
      query: Parameters<typeof execute>[0]
    ) => {
      await softDeleteUser(user.id);
      return execute(query);
    }) as unknown as typeof db.execute);

    await backfillEmailDomainBatch();

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, user.id));
    expect(row.email_domain).toBeNull();
    expect(row.google_user_email).not.toBe('someone@example.com');
  });
});
