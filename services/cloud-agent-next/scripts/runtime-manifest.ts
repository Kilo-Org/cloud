import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import {
  CONTROL_PLANE_SUPERVISOR,
  GIT_CREDENTIAL_HELPER,
  RUNTIME_DISTRIBUTION,
  RUNTIME_REQUIRED_BINARIES,
  WRAPPER_BUNDLES,
  runtimeInstallPath,
  wrapperBundle,
} from '../src/shared/runtime-distribution.js';

export const SNAPSHOT_RUNTIME = 'node24';
export const PINNED_BUN_VERSION = RUNTIME_DISTRIBUTION.bun;
export const SNAPSHOT_MANIFEST_PATH = '/usr/local/share/kilo/runtime-manifest.json';

export const SNAPSHOT_WRAPPER_PATH = runtimeInstallPath(wrapperBundle('src/main.ts').installName);
export const SNAPSHOT_CONTROL_PLANE_WRAPPER_PATH = runtimeInstallPath(
  wrapperBundle('src/control-plane/main.ts').installName
);
export const SNAPSHOT_CONTROL_PLANE_SUPERVISOR_PATH = runtimeInstallPath(
  CONTROL_PLANE_SUPERVISOR.installName
);

export type RuntimeManifestArtifact = {
  installName: string;
  sha256: string;
};

// The operator requires the full distribution: `validate` and `acceptance` read
// every local artifact, so an existing snapshot must be validated against a
// fully built copy. The Worker schema ignores these hashes, so deployed
// snapshots without them still start.
export type RuntimeManifest = {
  runtimeBuildId: string;
  wrapperVersion: string;
  runtime: typeof SNAPSHOT_RUNTIME;
  bunVersion: string;
  wrapperSha256: string;
  controlPlaneWrapperSha256: string;
  controlPlaneSupervisorSha256: string;
  artifacts: RuntimeManifestArtifact[];
};

export type RuntimeSourceFile = {
  installName: string;
  installPath: string;
  linkPath?: string;
  executable: boolean;
  localPath: string;
};

export type RuntimeArtifact = RuntimeSourceFile & { sha256: string };

const MANIFEST_SCALAR_KEYS = [
  'runtimeBuildId',
  'wrapperVersion',
  'runtime',
  'bunVersion',
  'wrapperSha256',
  'controlPlaneWrapperSha256',
  'controlPlaneSupervisorSha256',
] as const satisfies readonly (keyof RuntimeManifest)[];

const MANIFEST_REQUIRED_ARTIFACTS = [
  'kilocode-wrapper.js',
  'kilocode-control-plane-wrapper.js',
  'kilocode-control-plane-supervisor.sh',
] as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function runtimeDistributionSourceFiles(packageRoot: string): RuntimeSourceFile[] {
  return [
    ...WRAPPER_BUNDLES.map(bundle => ({
      installName: bundle.installName,
      installPath: runtimeInstallPath(bundle.installName),
      executable: bundle.executable,
      localPath: resolve(packageRoot, 'wrapper', 'dist', bundle.distName),
    })),
    {
      installName: CONTROL_PLANE_SUPERVISOR.installName,
      installPath: runtimeInstallPath(CONTROL_PLANE_SUPERVISOR.installName),
      executable: true,
      localPath: resolve(packageRoot, 'wrapper', CONTROL_PLANE_SUPERVISOR.wrapperPath),
    },
    {
      installName: GIT_CREDENTIAL_HELPER.installName,
      installPath: GIT_CREDENTIAL_HELPER.realPath,
      linkPath: GIT_CREDENTIAL_HELPER.linkPath,
      executable: true,
      localPath: resolve(packageRoot, GIT_CREDENTIAL_HELPER.packagePath),
    },
  ];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createRuntimeManifest(input: {
  runtimeBuildId: string;
  wrapperVersion: string;
  wrapperBytes: Uint8Array;
  controlPlaneWrapperBytes: Uint8Array;
  controlPlaneSupervisorBytes: Uint8Array;
  artifacts: readonly RuntimeManifestArtifact[];
  bunVersion?: string;
}): RuntimeManifest {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.runtimeBuildId)) {
    throw new Error('runtime build ID must be 1-128 URL-safe characters');
  }
  if (!/^\d+\.\d+\.\d+$/.test(input.wrapperVersion)) {
    throw new Error('wrapper version must be a semantic version');
  }
  const names = new Set(input.artifacts.map(artifact => artifact.installName));
  for (const installName of MANIFEST_REQUIRED_ARTIFACTS) {
    if (!names.has(installName)) throw new Error(`manifest is missing artifact ${installName}`);
  }
  for (const artifact of input.artifacts) {
    if (!SHA256_PATTERN.test(artifact.sha256))
      throw new Error(`artifact ${artifact.installName} has an invalid sha256`);
  }
  return {
    runtimeBuildId: input.runtimeBuildId,
    wrapperVersion: input.wrapperVersion,
    runtime: SNAPSHOT_RUNTIME,
    bunVersion: input.bunVersion ?? PINNED_BUN_VERSION,
    wrapperSha256: sha256Hex(input.wrapperBytes),
    controlPlaneWrapperSha256: sha256Hex(input.controlPlaneWrapperBytes),
    controlPlaneSupervisorSha256: sha256Hex(input.controlPlaneSupervisorBytes),
    artifacts: [...input.artifacts],
  };
}

export function validateRuntimeManifest(actual: unknown, expected: RuntimeManifest): string[] {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual))
    return ['manifest is not an object'];
  const record = actual as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of MANIFEST_SCALAR_KEYS) {
    if (!(key in record)) errors.push(`${key} missing`);
    else if (record[key] !== expected[key]) errors.push(`${key} mismatch`);
  }
  const actualArtifacts = record.artifacts;
  if (!Array.isArray(actualArtifacts)) {
    errors.push('artifacts missing');
    return errors;
  }
  const hashes = new Map<string, unknown>();
  for (const entry of actualArtifacts) {
    if (!entry || typeof entry !== 'object') continue;
    const installName = (entry as { installName?: unknown }).installName;
    if (typeof installName === 'string')
      hashes.set(installName, (entry as { sha256?: unknown }).sha256);
  }
  for (const artifact of expected.artifacts) {
    if (!hashes.has(artifact.installName)) errors.push(`artifacts.${artifact.installName} missing`);
    else if (hashes.get(artifact.installName) !== artifact.sha256)
      errors.push(`artifacts.${artifact.installName} mismatch`);
  }
  return errors;
}

export function hashRuntimeArtifacts(
  files: readonly (RuntimeSourceFile & { bytes: Uint8Array })[]
): RuntimeArtifact[] {
  return files.map(({ bytes, ...file }) => ({ ...file, sha256: sha256Hex(bytes) }));
}

export function runtimeManifestArtifacts(
  artifacts: readonly RuntimeArtifact[]
): RuntimeManifestArtifact[] {
  return artifacts.map(({ installName, sha256 }) => ({ installName, sha256 }));
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function exactVersionCommand(binary: string): string {
  return `${binary} --version | head -n1 | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1`;
}

export function exactVersionCheck(binary: string, version: string): string {
  return `test "$(${exactVersionCommand(binary)})" = ${shellQuote(version)}`;
}

export function runtimeVerificationScript(artifacts: readonly RuntimeArtifact[]): string {
  const pins = [
    `test "$(bun --version)" = ${shellQuote(RUNTIME_DISTRIBUTION.bun)}`,
    `test "$(pnpm --version)" = ${shellQuote(RUNTIME_DISTRIBUTION.pnpm)}`,
    exactVersionCheck('glab', RUNTIME_DISTRIBUTION.glab),
    exactVersionCheck('gh', RUNTIME_DISTRIBUTION.gh),
    `case "$(node --version)" in v${RUNTIME_DISTRIBUTION.nodeMajor}.*) ;; *) echo "unexpected node" >&2; exit 1 ;; esac`,
  ];
  const presence = RUNTIME_REQUIRED_BINARIES.map(binary => `command -v ${binary} >/dev/null`);
  const files = artifacts.map(artifact => {
    const checks = [
      `test "$(sha256sum ${shellQuote(artifact.installPath)} | cut -d' ' -f1)" = ${shellQuote(artifact.sha256)}`,
    ];
    if (artifact.executable) checks.push(`test -x ${shellQuote(artifact.installPath)}`);
    if (artifact.linkPath) checks.push(`test -L ${shellQuote(artifact.linkPath)}`);
    return checks.join(' && ');
  });
  return [...pins, ...presence, ...files].join(' && ');
}
