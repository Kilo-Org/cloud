import { db } from '@kilocode/web-shared/lib/drizzle';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';

export async function createTestOrganization(
  name: string,
  ownerId: string,
  microdollarBalance: number,
  settings?: object,
  requireSeats?: boolean
) {
  // Fixture setup must support existing accounts above the self-service creation limit.
  const organization = await createOrganization(name);

  await db.insert(organization_memberships).values({
    organization_id: organization.id,
    kilo_user_id: ownerId,
    role: 'owner',
  });

  await db
    .update(organizations)
    .set({
      created_by_kilo_user_id: ownerId,
      total_microdollars_acquired: microdollarBalance > 0 ? microdollarBalance : 0,
      microdollars_used: microdollarBalance < 0 ? Math.abs(microdollarBalance) : 0,
      microdollars_balance: microdollarBalance,
      ...(settings ? { settings } : {}),
      ...(requireSeats !== undefined ? { require_seats: requireSeats } : {}),
      plan: requireSeats ? 'teams' : 'enterprise',
    })
    .where(eq(organizations.id, organization.id));

  return { ...organization, created_by_kilo_user_id: ownerId };
}
