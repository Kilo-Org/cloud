/* eslint-disable drizzle/enforce-delete-with-where */
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { softDeleteUser } from '@/lib/user';
import { backfillNormalizedEmailBatch, countMissingNormalizedEmails } from './normalized-email';

afterEach(async () => {
  jest.restoreAllMocks();
  await db.delete(kilocode_users);
});

async function selectUser(id: string) {
  const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, id));
  return row;
}

it('fills missing normalized emails', async () => {
  const user = await insertTestUser({
    google_user_email: 'Some.One+tag@Example.com',
    normalized_email: null,
  });
  expect(await countMissingNormalizedEmails()).toBe(1);

  await expect(backfillNormalizedEmailBatch()).resolves.toEqual({ processed: 1, remaining: false });

  expect((await selectUser(user.id)).normalized_email).toBe('some.one@example.com');
  expect(await countMissingNormalizedEmails()).toBe(0);
});

it('does not write the old email onto a row soft-deleted after the select', async () => {
  const user = await insertTestUser({
    google_user_email: 'someone@example.com',
    normalized_email: null,
  });
  const execute = db.execute.bind(db);
  jest.spyOn(db, 'execute').mockImplementationOnce((async (
    query: Parameters<typeof execute>[0]
  ) => {
    await softDeleteUser(user.id);
    return execute(query);
  }) as unknown as typeof db.execute);

  await backfillNormalizedEmailBatch();

  const row = await selectUser(user.id);
  expect(row.google_user_email).not.toBe('someone@example.com');
  expect(row.normalized_email).not.toBe('someone@example.com');
});
