import { describe, expect, it } from 'vitest';
import { parseVercelSandboxRuntimeDefaults } from './vercel-runtime-config.js';

describe('BYOC Vercel runtime defaults', () => {
  const env = {
    VERCEL_SANDBOX_RUNTIME: 'node24',
    VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
    VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
  };
  it('parses durations without platform credentials or snapshot configuration', () => {
    expect(parseVercelSandboxRuntimeDefaults(env)).toEqual({
      runtime: 'node24',
      initialTimeoutMs: 300000,
      extendDurationMs: 600000,
    });
  });
  it.each(['0', '-1', 'invalid', '1.5'])('rejects invalid duration %s', duration => {
    expect(
      parseVercelSandboxRuntimeDefaults({ ...env, VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: duration })
    ).toBeUndefined();
  });
});
