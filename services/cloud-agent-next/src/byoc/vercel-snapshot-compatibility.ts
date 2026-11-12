import { z } from 'zod';

/**
 * The identity of the Vercel split image an environment snapshot was captured
 * from. A credential or project change is a different customer account, so a
 * snapshot must not be restored there even when the runtime build is unchanged.
 * `baseSnapshotId` is the snapshot actually mounted at build time: setup can
 * advance `runtimeBuildId` while the old snapshot remains current, so the build
 * id alone would mislabel an old filesystem as the new base.
 */
export function vercelSnapshotBaseImage(input: {
  credentialId: string;
  teamId: string;
  projectId: string;
  runtimeBuildId: string;
  baseSnapshotId: string;
}): string {
  return JSON.stringify([
    'vercel',
    input.credentialId,
    input.teamId,
    input.projectId,
    input.runtimeBuildId,
    input.baseSnapshotId,
  ]);
}

const vercelBaseImageSchema = z.tuple([
  z.literal('vercel'),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);

function vercelAccountOf(baseImage: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(baseImage);
  } catch {
    return null;
  }
  const parsed = vercelBaseImageSchema.safeParse(value);
  if (!parsed.success) return null;
  const [, credentialId, teamId, projectId] = parsed.data;
  return JSON.stringify([credentialId, teamId, projectId]);
}

/**
 * Whether two Vercel base identities name the same credential, team and
 * project. A snapshot from an earlier base in the same account can still be
 * restored; a snapshot from another account never can.
 */
export function sameVercelAccount(a: string, b: string): boolean {
  const account = vercelAccountOf(a);
  return account !== null && account === vercelAccountOf(b);
}
