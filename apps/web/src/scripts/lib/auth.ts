import { db } from '@/lib/drizzle';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { JWTTokenExtraPayload } from '@/lib/tokens';
import { generateApiToken } from '@/lib/tokens';

/**
 * Fetches the first user in the organization and generates an auth token
 */
export async function getAuthToken(
  organizationId: string,
  extraPayload?: JWTTokenExtraPayload
): Promise<string> {
  // Get the first member of the organization
  const memberships = await db
    .select({
      kilo_user_id: organization_memberships.kilo_user_id,
    })
    .from(organization_memberships)
    .where(eq(organization_memberships.organization_id, organizationId))
    .limit(1);

  if (memberships.length === 0) {
    throw new Error(`No members found in organization ${organizationId}`);
  }

  const userId = memberships[0].kilo_user_id;

  // Get the user details
  const users = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (users.length === 0) {
    throw new Error(`User ${userId} not found`);
  }

  const user = users[0];

  // Generate API token
  const token = generateApiToken(user, extraPayload);
  return token;
}
