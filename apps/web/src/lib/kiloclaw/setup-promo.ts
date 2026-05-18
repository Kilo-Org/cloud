import { readDb } from '@/lib/drizzle';
import { kiloclaw_instances } from '@kilocode/db';
import { eq } from 'drizzle-orm';

export async function userIsWithinFirstKiloClawInstanceWindow(params: {
  userId: string;
  maxAgeHours?: number;
}): Promise<boolean> {
  const maxAgeHours = params.maxAgeHours ?? 2;
  // Fetch the user's earliest instance (including destroyed ones — see test
  // "counts destroyed instances when computing the first-instance timestamp"
  // for rationale) and check the window in JS. Backed by
  // IDX_kiloclaw_instances_user_id_created_at so this is a single-row index
  // scan rather than a full aggregate over the user's history.
  const [row] = await readDb
    .select({ created_at: kiloclaw_instances.created_at })
    .from(kiloclaw_instances)
    .where(eq(kiloclaw_instances.user_id, params.userId))
    .orderBy(kiloclaw_instances.created_at)
    .limit(1);
  if (row == null) return false;
  const firstInstanceMs = new Date(row.created_at).getTime();
  return firstInstanceMs >= Date.now() - maxAgeHours * 60 * 60 * 1000;
}
