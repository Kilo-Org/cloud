import { vercelRuntimeBaseDigest } from './vercel-runtime-base.js';
import type { Env } from '../types.js';

export type VercelRuntimeIdentity = {
  wrapperVersion: string;
  releasedAt: string;
  digest: string;
};

export async function getVercelRuntimeIdentity(
  env: Pick<Env, 'RUNTIME_STARTUP_MODE'> = {}
): Promise<VercelRuntimeIdentity> {
  if (env.RUNTIME_STARTUP_MODE === undefined || env.RUNTIME_STARTUP_MODE === 'downloaded') {
    return {
      wrapperVersion: 'downloaded-base-v1',
      releasedAt: '2026-11-06',
      digest: await vercelRuntimeBaseDigest(),
    };
  }
  throw new Error('Only downloaded Vercel runtimes are supported');
}
