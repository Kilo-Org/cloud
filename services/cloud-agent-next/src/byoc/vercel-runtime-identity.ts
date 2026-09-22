import { KILO_CLI_VERSION } from '../shared/kilo-cli-version.js';
import { RUNTIME_DISTRIBUTION } from '../shared/runtime-distribution.js';
import { WRAPPER_RELEASED_AT, WRAPPER_VERSION } from '../shared/wrapper-version.js';
import { getVercelRuntimeArtifacts } from './vercel-runtime-artifacts.js';

export const VERCEL_RUNTIME_BUN_VERSION = RUNTIME_DISTRIBUTION.bun;
export const VERCEL_RUNTIME_KILO_CLI_VERSION = KILO_CLI_VERSION;

export type VercelRuntimeIdentity = {
  wrapperVersion: string;
  releasedAt: string;
  digest: string;
};

export function vercelRuntimeDigest(input: {
  wrapperVersion: string;
  releasedAt: string;
  controlWrapperSha256: string;
  kiloCliVersion: string;
  bunVersion: string;
  supervisorSha256?: string;
}): string {
  return [
    input.wrapperVersion,
    input.releasedAt,
    input.controlWrapperSha256,
    `cli:${input.kiloCliVersion}`,
    `bun:${input.bunVersion}`,
    ...(input.supervisorSha256 ? [input.supervisorSha256] : []),
  ].join('|');
}

export async function getVercelRuntimeIdentity(): Promise<VercelRuntimeIdentity> {
  const artifacts = await getVercelRuntimeArtifacts();
  const controlWrapper = artifacts.find(
    artifact => artifact.path === 'usr/local/bin/kilocode-control-plane-wrapper.js'
  );
  const supervisor = artifacts.find(
    artifact => artifact.path === 'usr/local/bin/kilocode-control-plane-supervisor.sh'
  );
  if (!controlWrapper || !supervisor) throw new Error('runtime_artifact_missing');

  return {
    wrapperVersion: WRAPPER_VERSION,
    releasedAt: WRAPPER_RELEASED_AT,
    digest: vercelRuntimeDigest({
      wrapperVersion: WRAPPER_VERSION,
      releasedAt: WRAPPER_RELEASED_AT,
      controlWrapperSha256: controlWrapper.sha256,
      supervisorSha256: supervisor.sha256,
      kiloCliVersion: VERCEL_RUNTIME_KILO_CLI_VERSION,
      bunVersion: VERCEL_RUNTIME_BUN_VERSION,
    }),
  };
}
