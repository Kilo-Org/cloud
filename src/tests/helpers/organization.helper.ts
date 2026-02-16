import { db } from '@/lib/drizzle';
import { organizations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createOrganization } from '@/lib/organizations/organizations';

export async function createTestOrganization(
  name: string,
  ownerId: string,
  microdollarBalance: number,
  settings?: object,
  requireSeats?: boolean
) {
  const organization = await createOrganization(name, ownerId);

  await db
    .update(organizations)
    .set({
      total_microdollars_acquired: microdollarBalance > 0 ? microdollarBalance : 0,
      microdollars_used: microdollarBalance < 0 ? Math.abs(microdollarBalance) : 0,
      microdollars_balance: microdollarBalance,
      ...(settings ? { settings } : {}),
      ...(requireSeats !== undefined ? { require_seats: requireSeats } : {}),
      plan: requireSeats ? 'teams' : 'enterprise',
    })
    .where(eq(organizations.id, organization.id));

  return organization;
}
