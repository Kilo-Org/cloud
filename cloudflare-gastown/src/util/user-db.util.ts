import { getWorkerDb } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Look up a user by their Kilo user ID. Returns the minimal fields
 * needed for ownership checks and token generation.
 */
export async function findUserById(
  connectionString: string,
  userId: string
): Promise<{ id: string; api_token_pepper: string | null; is_admin: boolean } | null> {
  const db = getWorkerDb(connectionString, { statement_timeout: 5_000 });
  const rows = await db
    .select({
      id: kilocode_users.id,
      api_token_pepper: kilocode_users.api_token_pepper,
      is_admin: kilocode_users.is_admin,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}
