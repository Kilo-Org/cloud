import { z } from 'zod';
import { RUNTIME_DISTRIBUTION } from '../shared/runtime-distribution.js';

/** One immutable descriptor pairs the CLI and control payloads for a platform. */

export const RUNTIME_RELEASE_FORMAT = 1;
export const RUNTIME_BOOTSTRAP_CONTRACT = 1;

/** Launch descriptor byte cap (plan §7 artifact bounds table). */
export const RUNTIME_DESCRIPTOR_MAX_BYTES = 65_536;

export const RUNTIME_ARTIFACT_ROLES = ['cli', 'control'] as const;
export type RuntimeArtifactRole = (typeof RUNTIME_ARTIFACT_ROLES)[number];

export const RUNTIME_ARCHITECTURES = ['x64', 'arm64'] as const;
export const RUNTIME_LIBCS = ['glibc', 'musl'] as const;
export const RUNTIME_CPU_TIERS = ['baseline', 'modern'] as const;

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The single HTTP path owner for artifact object reads. The route, the installer
 * fetch URL, and live tests all derive their URL from this, so they cannot drift
 * from the Worker route. The R2 storage key prefix is separate and owned by the
 * store module.
 */
export const RUNTIME_ARTIFACT_HTTP_PREFIX = '/sandbox-artifacts/v1/objects/';

export function runtimeArtifactHttpPath(sha256: string): string {
  return `${RUNTIME_ARTIFACT_HTTP_PREFIX}${sha256}`;
}

/** Match the shared object path and capture the hash, for fixture origins. */
export function runtimeArtifactHttpPathPattern(): RegExp {
  const prefix = RUNTIME_ARTIFACT_HTTP_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${prefix}([a-f0-9]{64})$`);
}

/** Hard installer policy caps. A descriptor's caps may not exceed these. */
export const RUNTIME_HARD_MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
export const RUNTIME_HARD_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
export const RUNTIME_HARD_MAX_FILE_COUNT = 20_000;
export const RUNTIME_FETCH_ATTEMPTS = 3;
/** Required base ABI/layout contract the descriptor must declare exactly. */
export const RUNTIME_BASE_ABI = 'kilo-runtime-base-v1';
/** The pinned Bun the base image and installer require, from the distribution owner. */
export const RUNTIME_BASE_BUN_VERSION = RUNTIME_DISTRIBUTION.bun;

const sha256Schema = z.string().regex(SHA256_PATTERN, 'invalid sha256');

/**
 * One authenticated installed file, tagged with the payload role it installs
 * from. The tuple form is used deliberately: the equivalent keyed-object form for
 * the measured CLI is ~62,999 bytes, which leaves too little headroom under the
 * 64 KiB descriptor cap.
 */
export const runtimeInventoryEntrySchema = z.tuple([
  z.enum(RUNTIME_ARTIFACT_ROLES),
  z.string().min(1).max(4096),
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  sha256Schema,
]);
export type RuntimeInventoryEntry = z.infer<typeof runtimeInventoryEntrySchema>;

export const runtimeArtifactSchema = z
  .object({
    role: z.enum(RUNTIME_ARTIFACT_ROLES),
    sha256: sha256Schema,
    transferBytes: z.number().int().positive(),
    expandedBytes: z.number().int().positive(),
    fileCount: z.number().int().positive(),
  })
  .strict();
export type RuntimeArtifact = z.infer<typeof runtimeArtifactSchema>;

export const runtimePlatformSchema = z
  .object({
    os: z.literal('linux'),
    arch: z.enum(RUNTIME_ARCHITECTURES),
    libc: z.enum(RUNTIME_LIBCS),
    cpu: z.enum(RUNTIME_CPU_TIERS),
  })
  .strict();
export type RuntimePlatform = z.infer<typeof runtimePlatformSchema>;

export const runtimeReleaseDescriptorSchema = z
  .object({
    format: z.literal(RUNTIME_RELEASE_FORMAT),
    bootstrap: z.literal(RUNTIME_BOOTSTRAP_CONTRACT),
    platform: runtimePlatformSchema,
    /** Required environment ABI/tool contract, independent of runtime version. */
    abi: z.string().min(1).max(128),
    cliVersion: z.string().min(1).max(64),
    /** Absolute-path target for CLI execution, relative to the CLI distribution root. */
    cliExecutable: z.string().min(1).max(512),
    wrapperSdkVersion: z.string().min(1).max(64),
    /** Tested Worker/runtime protocol contract. */
    protocol: z.string().min(1).max(64),
    artifacts: z.array(runtimeArtifactSchema).length(2),
    caps: z
      .object({
        maxTransferBytes: z.number().int().positive(),
        maxExpandedBytes: z.number().int().positive(),
        maxFileCount: z.number().int().positive(),
      })
      .strict(),
    inventory: z.array(runtimeInventoryEntrySchema).max(200_000),
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    const roles = new Set(descriptor.artifacts.map(artifact => artifact.role));
    if (roles.size !== RUNTIME_ARTIFACT_ROLES.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifacts'],
        message: 'descriptor must carry exactly one artifact per role',
      });
    }
    if (
      descriptor.caps.maxTransferBytes > RUNTIME_HARD_MAX_TRANSFER_BYTES ||
      descriptor.caps.maxExpandedBytes > RUNTIME_HARD_MAX_EXPANDED_BYTES ||
      descriptor.caps.maxFileCount > RUNTIME_HARD_MAX_FILE_COUNT
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['caps'],
        message: 'descriptor caps must not exceed the installer hard policy caps',
      });
    }
    if (
      descriptor.cliExecutable.startsWith('/') ||
      descriptor.cliExecutable.split('/').some(part => part === '' || part === '.' || part === '..')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cliExecutable'],
        message: 'cliExecutable must be a repository-relative path',
      });
    }
    const control = descriptor.artifacts.find(artifact => artifact.role === 'control');
    const perRole = {
      cli: descriptor.inventory.filter(entry => entry[0] === 'cli'),
      control: descriptor.inventory.filter(entry => entry[0] === 'control'),
    };
    // The executable must be a real, executable member of the CLI distribution.
    const executable = perRole.cli.find(entry => entry[1] === descriptor.cliExecutable);
    if (!executable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cliExecutable'],
        message: 'cliExecutable must name a file in the CLI inventory',
      });
    } else if ((executable[2] & 0o111) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cliExecutable'],
        message: 'cliExecutable must be an executable CLI inventory entry',
      });
    }
    for (const [role, artifact] of [
      ['cli', descriptor.artifacts.find(entry => entry.role === 'cli')],
      ['control', control],
    ] as const) {
      if (!artifact) continue;
      const entries = perRole[role];
      if (entries.length !== artifact.fileCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['inventory'],
          message: `inventory must carry exactly ${artifact.fileCount} ${role} files`,
        });
      }
      const expanded = entries.reduce((sum, entry) => sum + entry[3], 0);
      if (expanded !== artifact.expandedBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['inventory'],
          message: `inventory ${role} sizes must sum to the ${role} expanded size`,
        });
      }
      if (artifact.transferBytes > descriptor.caps.maxTransferBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts'],
          message: `${role} transfer size exceeds the declared transfer cap`,
        });
      }
      if (artifact.expandedBytes > descriptor.caps.maxExpandedBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts'],
          message: `${role} expanded size exceeds the declared expansion cap`,
        });
      }
      if (artifact.fileCount > descriptor.caps.maxFileCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts'],
          message: `${role} file count exceeds the declared file cap`,
        });
      }
    }
  });
export type RuntimeReleaseDescriptor = z.infer<typeof runtimeReleaseDescriptorSchema>;

/**
 * Serialize to the exact UTF-8 bytes that are embedded in launch configuration and
 * published as release evidence. Throws when the descriptor exceeds the launch
 * cap: a descriptor that cannot start is a blocked release, not a runtime fallback.
 */
export function serializeRuntimeRelease(descriptor: RuntimeReleaseDescriptor): Uint8Array {
  const parsed = runtimeReleaseDescriptorSchema.parse(descriptor);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  if (bytes.byteLength > RUNTIME_DESCRIPTOR_MAX_BYTES) {
    throw new Error(
      `runtime descriptor is ${bytes.byteLength} bytes, above the ${RUNTIME_DESCRIPTOR_MAX_BYTES} byte cap`
    );
  }
  return bytes;
}

/** Parse launch-supplied descriptor bytes. Any shape error rejects the launch. */
export function parseRuntimeRelease(input: string | Uint8Array): RuntimeReleaseDescriptor {
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
  return runtimeReleaseDescriptorSchema.parse(JSON.parse(text));
}

export function runtimeArtifactForRole(
  descriptor: RuntimeReleaseDescriptor,
  role: RuntimeArtifactRole
): RuntimeArtifact {
  const artifact = descriptor.artifacts.find(candidate => candidate.role === role);
  if (!artifact) throw new Error(`runtime descriptor is missing the ${role} artifact`);
  return artifact;
}

/** The two artifact hashes a read grant may authorize, in a stable order. */
export function runtimeArtifactHashes(descriptor: RuntimeReleaseDescriptor): [string, string] {
  return [
    runtimeArtifactForRole(descriptor, 'cli').sha256,
    runtimeArtifactForRole(descriptor, 'control').sha256,
  ];
}
