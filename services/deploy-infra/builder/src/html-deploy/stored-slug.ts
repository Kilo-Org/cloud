import type { WorkerDb } from '@kilocode/db/client';
import { deployments, deployments_ephemeral } from '@kilocode/db/schema';
import { eq, or } from 'drizzle-orm';

export async function isStoredDeploymentSlug(
  db: Pick<WorkerDb, 'select'>,
  slug: string
): Promise<boolean> {
  const persistent = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(or(eq(deployments.deployment_slug, slug), eq(deployments.internal_worker_name, slug)))
    .limit(1);

  if (persistent.length > 0) return true;

  const ephemeral = await db
    .select({ id: deployments_ephemeral.id })
    .from(deployments_ephemeral)
    .where(
      or(
        eq(deployments_ephemeral.deployment_slug, slug),
        eq(deployments_ephemeral.internal_worker_name, slug)
      )
    )
    .limit(1);

  return ephemeral.length > 0;
}
