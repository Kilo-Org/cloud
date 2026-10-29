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
