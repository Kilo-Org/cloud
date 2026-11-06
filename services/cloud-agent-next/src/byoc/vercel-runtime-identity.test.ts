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

describe('vercelRuntimeDigest', () => {
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
