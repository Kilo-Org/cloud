import { readDb } from '@/lib/drizzle';
import { kiloclaw_instances } from '@kilocode/db';
import { eq, sql } from 'drizzle-orm';

export async function userIsWithinFirstKiloClawInstanceWindow(params: {
  userId: string;
  maxAgeHours?: number;
}): Promise<boolean> {
  const maxAgeHours = params.maxAgeHours ?? 6;
  const [row] = await readDb
    .select({
      eligible: sql<boolean>`
        coalesce(
          min(${kiloclaw_instances.created_at}) >= now() - (${maxAgeHours} * interval '1 hour'),
          false
        )
      `,
    })
    .from(kiloclaw_instances)
    .where(eq(kiloclaw_instances.user_id, params.userId));
  return row?.eligible === true;
}
