import type { MachineSize, ProviderId } from '../schemas/instance-config';
import { MachineSizeSchema } from '../schemas/instance-config';
import { OPENCLAW_PORT, DEFAULT_MACHINE_GUEST } from '../config';
import type { RuntimeSpec } from '../providers/types';
import type { FlyMachineConfig } from '../fly/types';

// ============================================================================
// Metadata keys set on every Fly Machine for recovery/orphan detection.
// Avoid fly_* keys — those are reserved by Fly.
// ============================================================================

export const METADATA_KEY_USER_ID = 'kiloclaw_user_id';
export const METADATA_KEY_SANDBOX_ID = 'kiloclaw_sandbox_id';
export const METADATA_KEY_ORG_ID = 'kiloclaw_org_id';
export const METADATA_KEY_OPENCLAW_VERSION = 'kiloclaw_openclaw_version';
export const METADATA_KEY_IMAGE_VARIANT = 'kiloclaw_image_variant';
export const METADATA_KEY_DEV_CREATOR = 'kiloclaw_dev_creator';

// ============================================================================
// Neutral runtime spec builder
// ============================================================================

export type MachineIdentity = {
  userId: string;
  sandboxId: string;
  orgId: string | null;
  openclawVersion: string | null;
  imageVariant: string | null;
  devCreator: string | null;
};

export function buildRuntimeSpec(
  imageRef: string,
  envVars: Record<string, string>,
  bootstrapEnv: Record<string, string>,
  machineSize: MachineSize | null,
  identity: MachineIdentity,
  provider: ProviderId
): RuntimeSpec {
  return {
    imageRef,
    env: {
      ...envVars,
      KILOCLAW_RUNTIME_PROVIDER: provider,
      KILOCLAW_MACHINE_CPU_KIND: machineSize?.cpu_kind ?? DEFAULT_MACHINE_GUEST.cpu_kind,
    },
    bootstrapEnv,
    machineSize,
    rootMountPath: '/root',
    controllerPort: OPENCLAW_PORT,
    controllerHealthCheckPath: '/_kilo/health',
    metadata: {
      [METADATA_KEY_USER_ID]: identity.userId,
      [METADATA_KEY_SANDBOX_ID]: identity.sandboxId,
      ...(identity.orgId && { [METADATA_KEY_ORG_ID]: identity.orgId }),
      ...(identity.openclawVersion && {
        [METADATA_KEY_OPENCLAW_VERSION]: identity.openclawVersion,
      }),
      ...(identity.imageVariant && { [METADATA_KEY_IMAGE_VARIANT]: identity.imageVariant }),
      ...(identity.devCreator && { [METADATA_KEY_DEV_CREATOR]: identity.devCreator }),
    },
  };
}

export function guestFromSize(machineSize: MachineSize | null): FlyMachineConfig['guest'] {
  if (!machineSize) return DEFAULT_MACHINE_GUEST;
  return {
    cpus: machineSize.cpus,
    memory_mb: machineSize.memory_mb,
    cpu_kind: machineSize.cpu_kind ?? 'shared',
  };
}

/**
 * Validate a Fly-observed guest shape against `MachineSizeSchema` before
 * writing it to DO state. Returns null when the shape doesn't conform —
 * e.g. an unexpected `cpu_kind` value Fly may introduce in the future.
 *
 * Centralizes the validation so all three backfill sites (reconcile alarm,
 * `startExistingMachine`, the user-facing live-check) use the same rules.
 * Avoids the `as 'shared' | 'performance' | undefined` cast that would
 * otherwise let unknown vocabulary into DO state where downstream
 * `tierFromMachineSize` would silently mark the instance as `'custom'`.
 */
export function parseMachineSizeFromFlyGuest(guest: {
  cpus: number;
  memory_mb: number;
  cpu_kind?: string;
}): MachineSize | null {
  const parsed = MachineSizeSchema.safeParse({
    cpus: guest.cpus,
    memory_mb: guest.memory_mb,
    cpu_kind: guest.cpu_kind,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Hardware that should drive the runtime spec for this instance right now.
 *
 * Returns `adminMachineSizeOverride` if set (admin temporary CPU/RAM bump
 * for support workflows), otherwise the tier-derived `machineSize`. The
 * billable tier (`instanceType`/`volumeSizeGb`) and any tier comparisons
 * must continue reading `state.machineSize` directly — `effectiveMachineSize`
 * is for runtime spec / Fly guest construction only.
 */
export function effectiveMachineSize(state: {
  machineSize: MachineSize | null;
  adminMachineSizeOverride: MachineSize | null;
}): MachineSize | null {
  return state.adminMachineSizeOverride ?? state.machineSize;
}

// ============================================================================
// Volume name helper
// ============================================================================

export function volumeNameFromSandboxId(sandboxId: string): string {
  return `kiloclaw_${sandboxId}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 30);
}
