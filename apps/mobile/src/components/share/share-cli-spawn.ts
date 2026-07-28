import { type inferRouterOutputs, type RootRouter } from '@kilocode/trpc';

type RouterOutputs = inferRouterOutputs<RootRouter>;

/**
 * One connected CLI instance from `activeSessions.listInstances`. Derived
 * from tRPC so S3's optional `capabilities.attachments` is present without
 * copying shapes (do not use `InstancePickerInstance`, which omits it).
 */
export type ShareCliSpawnRow =
  RouterOutputs['activeSessions']['listInstances']['instances'][number];

/**
 * Rows to offer as "new session on a connected CLI" in the share gate.
 *
 * Empty unless the org context has finished loading as personal
 * (`orgLoaded && organizationId == null`), the gate shows its New-session
 * row, and there is at least one connected instance. Before org load,
 * `organizationId` defaults to `null` with `isLoaded: false` — that must
 * not collapse into "personal".
 */
export function selectShareCliSpawnRows({
  instances,
  organizationId,
  orgLoaded,
  gateShowsNewSession,
}: {
  instances: readonly ShareCliSpawnRow[];
  organizationId: string | null | undefined;
  orgLoaded: boolean;
  gateShowsNewSession: boolean;
}): readonly ShareCliSpawnRow[] {
  if (!orgLoaded || organizationId != null || !gateShowsNewSession) {
    return [];
  }
  if (instances.length === 0) {
    return [];
  }
  return instances;
}

/**
 * Whether a `ready` spawn may commit navigation with the staged share.
 * False when another destination already committed (19c) or the user
 * dismissed/unmounted mid-spawn and cleared the payload (19b).
 */
export function shouldCommitShareSpawnReady({
  committedShareId,
  payloadStillStaged,
}: {
  committedShareId: string | null;
  payloadStillStaged: boolean;
}): boolean {
  return committedShareId == null && payloadStillStaged;
}
