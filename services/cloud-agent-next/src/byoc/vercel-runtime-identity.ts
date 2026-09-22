import { WRAPPER_RELEASED_AT, WRAPPER_VERSION } from '../shared/wrapper-version.js';
import { getVercelRuntimeArtifacts } from './vercel-runtime-artifacts.js';

export const VERCEL_RUNTIME_BUN_VERSION = '1.3.14';
export const VERCEL_RUNTIME_KILO_CLI_VERSION = '7.4.20';

export type VercelRuntimeIdentity = {
  wrapperVersion: string;
  releasedAt: string;
  digest: string;
};

export function vercelRuntimeDigest(input: {
  wrapperVersion: string;
  releasedAt: string;
  wrapperSha256: string;
  controlWrapperSha256: string;
  kiloCliVersion: string;
  bunVersion: string;
}): string {
  return [
    input.wrapperVersion,
    input.releasedAt,
    input.wrapperSha256,
    input.controlWrapperSha256,
    `cli:${input.kiloCliVersion}`,
    `bun:${input.bunVersion}`,
  ].join('|');
}

export async function getVercelRuntimeIdentity(): Promise<VercelRuntimeIdentity> {
  const artifacts = await getVercelRuntimeArtifacts();
  const wrapper = artifacts.find(artifact => artifact.path === 'usr/local/bin/kilocode-wrapper.js');
  const controlWrapper = artifacts.find(
    artifact => artifact.path === 'usr/local/bin/kilocode-control-wrapper.js'
  );
  if (!wrapper || !controlWrapper) throw new Error('runtime_artifact_missing');

  return {
    wrapperVersion: WRAPPER_VERSION,
    releasedAt: WRAPPER_RELEASED_AT,
    digest: vercelRuntimeDigest({
      wrapperVersion: WRAPPER_VERSION,
      releasedAt: WRAPPER_RELEASED_AT,
      wrapperSha256: wrapper.sha256,
      controlWrapperSha256: controlWrapper.sha256,
      kiloCliVersion: VERCEL_RUNTIME_KILO_CLI_VERSION,
      bunVersion: VERCEL_RUNTIME_BUN_VERSION,
    }),
  };
}
