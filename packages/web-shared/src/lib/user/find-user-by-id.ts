import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

/**
 * @param fromDb - Database instance to use (defaults to primary db, pass readDb for replica)
 */
export async function findUserById(
  userId: string,
  fromDb: typeof db = db
): Promise<User | undefined> {
  return await fromDb.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
}
