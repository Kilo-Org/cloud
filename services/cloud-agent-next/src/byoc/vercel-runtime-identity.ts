import { RUNTIME_DISTRIBUTION } from '../shared/runtime-distribution.js';
import { vercelRuntimeBaseDigest } from './vercel-runtime-base.js';

export const VERCEL_RUNTIME_BUN_VERSION = RUNTIME_DISTRIBUTION.bun;

export type VercelRuntimeIdentity = {
  wrapperVersion: string;
  releasedAt: string;
  digest: string;
};

export async function getVercelRuntimeIdentity(): Promise<VercelRuntimeIdentity> {
  return {
    wrapperVersion: 'downloaded-base-v1',
    releasedAt: '2026-10-23',
    digest: await vercelRuntimeBaseDigest(),
  };
}
