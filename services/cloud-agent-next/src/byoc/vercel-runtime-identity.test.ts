import { describe, expect, it } from 'vitest';
import { getVercelRuntimeIdentity } from './vercel-runtime-identity.js';

describe('Vercel runtime base identity', () => {
  it('uses the same base identity across downloaded CLI and control releases', async () => {
    const first = { RUNTIME_STARTUP_MODE: 'downloaded', RUNTIME_RELEASE_DESCRIPTOR: 'release-a' };
    const second = { ...first, RUNTIME_RELEASE_DESCRIPTOR: 'release-b' };
    const identity = await getVercelRuntimeIdentity(first);
    expect(await getVercelRuntimeIdentity(second)).toEqual(identity);
    expect(identity.digest).toMatch(/^downloaded-base-v1:[a-f0-9]{64}$/);
    expect(identity.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await getVercelRuntimeIdentity()).toEqual(identity);
  });
  it('rejects preinstalled identity selection instead of bundling runtime artifacts', async () => {
    await expect(
      getVercelRuntimeIdentity({ RUNTIME_STARTUP_MODE: 'preinstalled' })
    ).rejects.toThrow('downloaded');
  });
});
