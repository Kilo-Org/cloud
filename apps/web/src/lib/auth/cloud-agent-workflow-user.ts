import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { isResourceTokenIssuanceEnabled, type ResourceTokenFamily } from '@/lib/config.server';

export async function prepareCloudAgentWorkflowUser(
  user: User,
  requiredFamilies: readonly ResourceTokenFamily[] = ['cloud-agent-next']
): Promise<User> {
  if (!requiredFamilies.some(isResourceTokenIssuanceEnabled) || user.api_token_pepper !== null) {
    return user;
  }

  // Use the primary's persisted value: another issuer or revocation may have
  // assigned a pepper since this user was loaded. Never overwrite that value.
  const [currentUser] = await db
    .update(kilocode_users)
    .set({ api_token_pepper: sql`COALESCE(${kilocode_users.api_token_pepper}, ${randomUUID()})` })
    .where(eq(kilocode_users.id, user.id))
    .returning();
  if (!currentUser) throw new Error(`User ${user.id} not found`);
  return currentUser;
}
