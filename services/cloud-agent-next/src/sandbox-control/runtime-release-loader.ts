import { runtimeArtifactObjectKey } from './runtime-artifact-store.js';
import {
  RUNTIME_DESCRIPTOR_MAX_BYTES,
  parseRuntimeRelease,
  runtimeArtifactForRole,
  type RuntimeArtifact,
  type RuntimeReleaseDescriptor,
} from '../shared/runtime-release.js';
import type { ControlPlaneFailureReason } from '../shared/control-plane-protocol.js';
import {
  RUNTIME_INSTALLER_EXIT,
  type RuntimeLaunchInstallerCode,
} from './runtime-launch-receipt.js';

/**
 * Worker-side cold-launch preflight (plan amendment "cold session without a
 * snapshot").
 *
 * The launch supplies one trusted generated-config string,
 * `RUNTIME_RELEASE_DESCRIPTOR`. This module parses it with the shared schema and
 * verifies that the two named payload objects exist in the private bucket at
 * their content-addressed keys with the declared transfer size. The provider
 * then mints the read grant from those hashes and launches
 * `runtimeLaunchCommand()`.
 *
 * The descriptor never comes from a request body, an R2 descriptor object, or a
 * sandbox file. An absent descriptor is the explicit baked selection (`null`).
 * A descriptor that is present but unparsable or unverifiable is a hard launch
 * failure: it must not fall back to the baked path, because the baked runtime is
 * exactly what it replaces.
 *
 * The preflight reads object metadata only. Content integrity is owned by the
 * installer, which hashes the downloaded bytes before it installs them, and by
 * create-only publication, which re-reads and hashes every stored object. Reading
 * the payload here as well would add a full CLI transfer to every cold launch.
 */

/**
 * The closed reason set the preflight and the installer phase can fail with,
 * shared by the launch provider and the sandbox DO. These are not a generic
 * status: each names the one thing the caller can tell the user, and each is a
 * control-plane failure reason so one typed error reaches the route owner.
 *
 * `runtime_artifact_missing` is preflight-only (no published object);
 * `runtime_artifact_unauthorized`, `runtime_base_incompatible`,
 * `runtime_install_probe_failed` and `runtime_supervisor_missing` come from the
 * installer's typed exit receipt. Every member is a `ControlPlaneFailureReason`.
 */
export const RUNTIME_INSTALLER_FAILURE_REASONS = [
  'runtime_artifact_missing',
  'runtime_artifact_unavailable',
  'runtime_artifact_integrity',
  'runtime_artifact_unauthorized',
  'runtime_base_incompatible',
  'runtime_install_probe_failed',
  'runtime_supervisor_missing',
  'runtime_artifact_deadline',
] as const satisfies readonly ControlPlaneFailureReason[];
export type RuntimeInstallerFailureReason = (typeof RUNTIME_INSTALLER_FAILURE_REASONS)[number];

const RUNTIME_INSTALLER_REASON_BY_CODE = {
  [RUNTIME_INSTALLER_EXIT.artifactUnavailable]: 'runtime_artifact_unavailable',
  [RUNTIME_INSTALLER_EXIT.artifactUnauthorized]: 'runtime_artifact_unauthorized',
  [RUNTIME_INSTALLER_EXIT.baseIncompatible]: 'runtime_base_incompatible',
  [RUNTIME_INSTALLER_EXIT.artifactInvalid]: 'runtime_artifact_integrity',
  [RUNTIME_INSTALLER_EXIT.installInterrupted]: 'runtime_install_probe_failed',
  [RUNTIME_INSTALLER_EXIT.deadlineExceeded]: 'runtime_artifact_deadline',
  [RUNTIME_INSTALLER_EXIT.cliProbeFailed]: 'runtime_install_probe_failed',
  [RUNTIME_INSTALLER_EXIT.supervisorMissing]: 'runtime_supervisor_missing',
} as const satisfies Record<RuntimeLaunchInstallerCode, RuntimeInstallerFailureReason>;

/**
 * Map one installer exit code to its typed reason. The codes are disjoint from
 * supervisor/wrapper exit codes, so a supervisor that exits with one of them
 * after a handoff is never read as an installer phase here.
 */
export function runtimeInstallerReasonForCode(
  code: RuntimeLaunchInstallerCode
): RuntimeInstallerFailureReason {
  return RUNTIME_INSTALLER_REASON_BY_CODE[code];
}

export class RuntimeInstallerError extends Error {
  constructor(
    readonly reason: RuntimeInstallerFailureReason,
    message: string
  ) {
    super(message);
    this.name = 'RuntimeInstallerError';
  }
}

/**
 * The minimal object surface the preflight needs. R2 exposes it directly; tests
 * supply small in-memory adapters. Keeping the surface narrow avoids an
 * `unknown` cast at the call site and keeps the loader free of the full R2 and
 * provider types.
 */
export type RuntimeArtifactReader = {
  head(key: string): Promise<{ size: number } | null>;
};

export type RuntimeReleaseLoadInput = {
  reader: RuntimeArtifactReader;
  /** The trusted generated-config value; `undefined` is a baked image. */
  descriptor: string | undefined;
  /** Absolute epoch-ms deadline covering the whole preflight. */
  deadlineAt: number;
};

function integrity(message: string): RuntimeInstallerError {
  return new RuntimeInstallerError('runtime_artifact_integrity', message);
}

function unavailable(message: string): RuntimeInstallerError {
  return new RuntimeInstallerError('runtime_artifact_unavailable', message);
}

function missing(message: string): RuntimeInstallerError {
  return new RuntimeInstallerError('runtime_artifact_missing', message);
}

function deadline(message: string): RuntimeInstallerError {
  return new RuntimeInstallerError('runtime_artifact_deadline', message);
}

async function verifyArtifact(
  reader: RuntimeArtifactReader,
  artifact: RuntimeArtifact,
  deadlineAt: number
): Promise<void> {
  const key = runtimeArtifactObjectKey(artifact.sha256);
  if (Date.now() > deadlineAt) {
    throw deadline(`${key}: release deadline passed before the object was checked`);
  }
  let head: { size: number } | null;
  try {
    head = await reader.head(key);
  } catch {
    throw unavailable(`${key}: object metadata read failed`);
  }
  if (head === null) throw missing(`${key}: object is not published`);
  if (head.size !== artifact.transferBytes) {
    throw integrity(
      `${key}: stored size ${head.size} does not match the declared ${artifact.transferBytes}`
    );
  }
}

/**
 * Verify the trusted launch descriptor against the private object store.
 *
 * Returns `null` when the descriptor is absent: the caller launches the baked
 * `CONTROL_SUPERVISOR_PATH`. Returns the verified descriptor otherwise. Throws
 * a `RuntimeInstallerError` with a closed reason when a present descriptor is
 * unparsable, over the byte cap, or names an object that is missing or has the
 * wrong stored size within the deadline. A thrown error is final; there is no
 * baked fallback for a descriptor that was supplied.
 */
export async function loadRuntimeRelease(
  input: RuntimeReleaseLoadInput
): Promise<RuntimeReleaseDescriptor | null> {
  const { descriptor, deadlineAt } = input;
  if (descriptor === undefined) return null;
  if (Date.now() > deadlineAt) {
    throw deadline('runtime release deadline passed before the descriptor was verified');
  }

  const bytes = new TextEncoder().encode(descriptor);
  if (bytes.byteLength > RUNTIME_DESCRIPTOR_MAX_BYTES) {
    throw integrity(
      `runtime descriptor is ${bytes.byteLength} bytes, above the ${RUNTIME_DESCRIPTOR_MAX_BYTES} byte cap`
    );
  }

  let release: RuntimeReleaseDescriptor;
  try {
    release = parseRuntimeRelease(descriptor);
  } catch {
    throw integrity('runtime descriptor does not match the release schema');
  }

  await verifyArtifact(input.reader, runtimeArtifactForRole(release, 'cli'), deadlineAt);
  await verifyArtifact(input.reader, runtimeArtifactForRole(release, 'control'), deadlineAt);

  return release;
}
