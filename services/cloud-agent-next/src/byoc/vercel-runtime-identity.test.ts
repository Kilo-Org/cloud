import { describe, expect, it } from 'vitest';

import { getVercelRuntimeIdentity } from './vercel-runtime-identity.js';

describe('getVercelRuntimeIdentity', () => {
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
