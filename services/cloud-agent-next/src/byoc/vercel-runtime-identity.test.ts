import { describe, expect, it, vi } from 'vitest';

import * as runtimeDistribution from '../shared/runtime-distribution.js';
import { getVercelRuntimeIdentity } from './vercel-runtime-identity.js';
import { vercelRuntimeBaseDigest } from './vercel-runtime-base.js';

describe('getVercelRuntimeIdentity', () => {
  it.each([{ ghStack: '0.3.1' }, { ghStackSha256: 'a'.repeat(64) }])(
    'invalidates the downloaded base when the gh-stack pin changes: %j',
    async changedPin => {
      const originalDigest = await vercelRuntimeBaseDigest();
      vi.resetModules();
      vi.doMock('../shared/runtime-distribution.js', async importOriginal => ({
        ...(await importOriginal<typeof runtimeDistribution>()),
        RUNTIME_DISTRIBUTION: { ...runtimeDistribution.RUNTIME_DISTRIBUTION, ...changedPin },
      }));
      try {
        const { vercelRuntimeBaseDigest: changedDigest } = await import('./vercel-runtime-base.js');
        expect(await changedDigest()).not.toBe(originalDigest);
      } finally {
        vi.doUnmock('../shared/runtime-distribution.js');
        vi.resetModules();
      }
    }
  );

  it('reports one stable base identity for every downloaded runtime', async () => {
    const first = await getVercelRuntimeIdentity();
    const second = await getVercelRuntimeIdentity();

    expect(second).toEqual(first);
    expect(first).toEqual({
      wrapperVersion: 'downloaded-base-v1',
      releasedAt: '2026-10-23',
      digest: expect.stringMatching(/^downloaded-base-v1:[a-f0-9]{64}$/),
    });
  });
});
