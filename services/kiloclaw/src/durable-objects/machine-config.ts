import type { MachineSize } from '../schemas/instance-config';
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
  machineSize: MachineSize | null,
  identity: MachineIdentity
): RuntimeSpec {
  return {
    imageRef,
    env: envVars,
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

// ============================================================================
// Volume name helper
// ============================================================================

export function volumeNameFromSandboxId(sandboxId: string): string {
  return `kiloclaw_${sandboxId}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 30);
}
