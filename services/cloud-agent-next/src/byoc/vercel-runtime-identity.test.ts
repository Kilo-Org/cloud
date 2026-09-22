import { describe, expect, it, vi } from 'vitest';

vi.mock('./vercel-runtime-artifacts.js', () => ({
  getVercelRuntimeArtifacts: vi.fn(),
}));

import {
  VERCEL_RUNTIME_BUN_VERSION,
  VERCEL_RUNTIME_KILO_CLI_VERSION,
  vercelRuntimeDigest,
} from './vercel-runtime-identity.js';

describe('vercelRuntimeDigest', () => {
  it('changes when the control wrapper hash changes', () => {
    const base = {
      wrapperVersion: '2.4.0',
      releasedAt: '2026-09-08',
      wrapperSha256: 'aa',
      controlWrapperSha256: 'bb',
      kiloCliVersion: VERCEL_RUNTIME_KILO_CLI_VERSION,
      bunVersion: VERCEL_RUNTIME_BUN_VERSION,
    };
    expect(vercelRuntimeDigest({ ...base, controlWrapperSha256: 'cc' })).not.toBe(
      vercelRuntimeDigest(base)
    );
  });
});
