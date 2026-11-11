import { describe, expect, it, vi } from 'vitest';

vi.mock('./vercel-runtime-artifacts.js', () => ({
  getVercelRuntimeArtifacts: vi.fn(),
}));

import {
  VERCEL_RUNTIME_BUN_VERSION,
  VERCEL_RUNTIME_KILO_CLI_VERSION,
  vercelRuntimeDigest,
  getVercelRuntimeIdentity,
} from './vercel-runtime-identity.js';
import { getVercelRuntimeArtifacts } from './vercel-runtime-artifacts.js';
import * as runtimeDistribution from '../shared/runtime-distribution.js';
import { vercelRuntimeBaseDigest } from './vercel-runtime-base.js';

describe('vercelRuntimeDigest', () => {
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

  it('uses the same base identity across downloaded CLI and control releases', async () => {
    const first = { RUNTIME_STARTUP_MODE: 'downloaded', RUNTIME_RELEASE_DESCRIPTOR: 'release-a' };
    const second = { ...first, RUNTIME_RELEASE_DESCRIPTOR: 'release-b' };
    const identity = await getVercelRuntimeIdentity(first);
    expect(await getVercelRuntimeIdentity(second)).toEqual(identity);
    expect(identity.digest).toMatch(/^downloaded-base-v1:[a-f0-9]{64}$/);
    expect(identity.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getVercelRuntimeArtifacts).not.toHaveBeenCalled();
  });
  it('changes when the control-plane supervisor changes', () => {
    const base = {
      wrapperVersion: '2.4.0',
      releasedAt: '2026-09-08',
      controlWrapperSha256: 'bb',
      kiloCliVersion: VERCEL_RUNTIME_KILO_CLI_VERSION,
      bunVersion: VERCEL_RUNTIME_BUN_VERSION,
    };
    expect(vercelRuntimeDigest({ ...base, supervisorSha256: 'cc' })).not.toBe(
      vercelRuntimeDigest({ ...base, supervisorSha256: 'dd' })
    );
  });
  it('changes when the control wrapper hash changes', () => {
    const base = {
      wrapperVersion: '2.4.0',
      releasedAt: '2026-09-08',
      controlWrapperSha256: 'bb',
      kiloCliVersion: VERCEL_RUNTIME_KILO_CLI_VERSION,
      bunVersion: VERCEL_RUNTIME_BUN_VERSION,
    };
    expect(vercelRuntimeDigest({ ...base, controlWrapperSha256: 'cc' })).not.toBe(
      vercelRuntimeDigest(base)
    );
  });
});
