import { z } from 'zod';
import {
  CONTROL_GIT_CREDENTIAL_RECORD_PATH,
  HOME_CREDENTIAL_FILES,
} from './runtime-environment.js';
import {
  CONTROL_PLANE_SUPERVISOR,
  GIT_CREDENTIAL_HELPER,
  RUNTIME_RESERVED_ROOT,
  WRAPPER_BUNDLES,
  runtimeInstallPath,
} from './runtime-distribution.js';

export const ROOTFS_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 5 * 1024 ** 3,
  maxEntries: 250_000,
  maxMetadataBytes: 64 * 1024 ** 2,
  maxPaxBytes: 128 * 1024,
});
export const ROOTFS_ARCHIVE_PROTECTED_PATHS = Object.freeze([
  '.kilo-rootfs',
  'proc',
  'sys',
  'dev',
  'run',
  'tmp',
  'opt/kilo',
  RUNTIME_RESERVED_ROOT.slice(1),
  'etc/hosts',
  'etc/resolv.conf',
  'etc/hostname',
  'etc/machine-id',
  'usr/local/bin/node',
  'usr/local/bin/bun',
  ...WRAPPER_BUNDLES.map(bundle => runtimeInstallPath(bundle.installName).slice(1)),
  runtimeInstallPath(CONTROL_PLANE_SUPERVISOR.installName).slice(1),
  GIT_CREDENTIAL_HELPER.realPath.slice(1),
  GIT_CREDENTIAL_HELPER.linkPath.slice(1),
]);
export const ROOTFS_ARCHIVE_CREDENTIAL_PATHS = Object.freeze([
  CONTROL_GIT_CREDENTIAL_RECORD_PATH,
  ...HOME_CREDENTIAL_FILES,
  '.ssh',
  '.aws',
  '.config/gh/hosts.yml',
  '.config/glab-cli/config.yml',
]);
export const rootfsArchiveDescriptorSchema = z
  .object({
    format: z.literal(1),
    baseImage: z.string().min(1).max(2048),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().max(ROOTFS_ARCHIVE_LIMITS.maxArchiveBytes),
    expandedBytes: z.number().int().nonnegative().max(ROOTFS_ARCHIVE_LIMITS.maxArchiveBytes),
    fileCount: z.number().int().nonnegative().max(ROOTFS_ARCHIVE_LIMITS.maxEntries),
    deletedCount: z.number().int().nonnegative().max(ROOTFS_ARCHIVE_LIMITS.maxEntries),
  })
  .strict();
export type RootfsArchiveDescriptor = z.infer<typeof rootfsArchiveDescriptorSchema>;

/** Trusted configuration only. Archive contents cannot select their own protected paths or limits. */
export function rootfsArchiveConfiguration() {
  return {
    ...ROOTFS_ARCHIVE_LIMITS,
    protectedPaths: ROOTFS_ARCHIVE_PROTECTED_PATHS,
    credentialPaths: ROOTFS_ARCHIVE_CREDENTIAL_PATHS,
  };
}
