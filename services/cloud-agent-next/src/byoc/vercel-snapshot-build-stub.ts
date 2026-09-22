import type { VercelSnapshotBuild } from '../persistence/VercelSnapshotBuild.js';
import type { Env } from '../types.js';

export function getVercelSnapshotBuildStub(
  env: Pick<Env, 'VERCEL_SNAPSHOT_BUILD'>,
  organizationId: string
): DurableObjectStub<VercelSnapshotBuild> {
  if (!env.VERCEL_SNAPSHOT_BUILD) throw new Error('Vercel snapshot build binding is unavailable');
  return env.VERCEL_SNAPSHOT_BUILD.getByName(organizationId);
}
