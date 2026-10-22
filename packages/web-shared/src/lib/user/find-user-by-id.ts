import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Access decisions and revocation checks compare against the stored row, so
 * this reads the primary only; a replica handle is not accepted.
 */
export async function findUserById(userId: string): Promise<User | undefined> {
  return await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });
}
