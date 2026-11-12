import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';

/** The only organization data the access-needed page may render before access. */
export async function getLiveOrganizationName(organizationId: string): Promise<string | null> {
  const [organization] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .limit(1);
  return organization?.name ?? null;
}
