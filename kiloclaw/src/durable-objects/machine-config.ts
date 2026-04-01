import type { FlyMachineConfig } from '../fly/types';
import type { MachineSize } from '../schemas/instance-config';
import { OPENCLAW_PORT, DEFAULT_MACHINE_GUEST } from '../config';

// ============================================================================
// Metadata keys set on every Fly Machine for recovery/orphan detection.
// Avoid fly_* keys — those are reserved by Fly.
// ============================================================================

export const METADATA_KEY_USER_ID = 'kiloclaw_user_id';
export const METADATA_KEY_SANDBOX_ID = 'kiloclaw_sandbox_id';
export const METADATA_KEY_ORG_ID = 'kiloclaw_org_id';
export const METADATA_KEY_OPENCLAW_VERSION = 'kiloclaw_openclaw_version';
export const METADATA_KEY_IMAGE_VARIANT = 'kiloclaw_image_variant';

// ============================================================================
// Machine config builder
// ============================================================================

export type MachineIdentity = {
  userId: string;
  sandboxId: string;
  orgId: string | null;
  openclawVersion: string | null;
  imageVariant: string | null;
};

export function buildMachineConfig(
  registryApp: string,
  imageTag: string,
  envVars: Record<string, string>,
  guest: FlyMachineConfig['guest'],
  flyVolumeId: string | null,
  identity: MachineIdentity
): FlyMachineConfig {
  return {
    image: `registry.fly.io/${registryApp}:${imageTag}`,
    env: envVars,
    guest,
    services: [
      {
        ports: [{ port: 443, handlers: ['tls', 'http'] }],
        internal_port: OPENCLAW_PORT,
        protocol: 'tcp' as const,
        autostart: false,
        autostop: 'off',
      },
    ],
    checks: {
      controller: {
        type: 'http',
        port: OPENCLAW_PORT,
        method: 'GET',
        path: '/_kilo/health',
        interval: '30s',
        timeout: '5s',
        grace_period: '120s',
      },
    },
    mounts: flyVolumeId ? [{ volume: flyVolumeId, path: '/root' }] : [],
    metadata: {
      [METADATA_KEY_USER_ID]: identity.userId,
      [METADATA_KEY_SANDBOX_ID]: identity.sandboxId,
      ...(identity.orgId && { [METADATA_KEY_ORG_ID]: identity.orgId }),
      ...(identity.openclawVersion && {
        [METADATA_KEY_OPENCLAW_VERSION]: identity.openclawVersion,
      }),
      ...(identity.imageVariant && { [METADATA_KEY_IMAGE_VARIANT]: identity.imageVariant }),
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
