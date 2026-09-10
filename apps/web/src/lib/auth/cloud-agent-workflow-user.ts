import { eq } from 'drizzle-orm';
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

  // Reload null snapshots from the primary without revoking existing credentials.
  // Another issuer or revocation may have assigned a pepper since this user was loaded.
  const [currentUser] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, user.id));
  if (!currentUser) throw new Error(`User ${user.id} not found`);
  return currentUser;
}
