import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import {
  parseRuntimeProxyOriginProof,
  runtimeProxyOriginProof,
} from './runtime-credential-proxy-origin.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseRuntimeProxyOriginProof', () => {
  it('accepts exactly one platform proof', async () => {
    const proof = await runtimeProxyOriginProof({ NEXTAUTH_SECRET: 'secret' }, 'sandbox-1');
    expect(proof).not.toBeNull();
    expect(parseRuntimeProxyOriginProof(proof)).toBe(proof);
  });

  it('treats a joined duplicate, a wrong length, or a missing value as absent', async () => {
    const proof = await runtimeProxyOriginProof({ NEXTAUTH_SECRET: 'secret' }, 'sandbox-1');
    expect(parseRuntimeProxyOriginProof(`forged, ${proof}`)).toBeUndefined();
    expect(parseRuntimeProxyOriginProof(`${proof}A`)).toBeUndefined();
    expect(parseRuntimeProxyOriginProof('')).toBeUndefined();
    expect(parseRuntimeProxyOriginProof(undefined)).toBeUndefined();
  });
});

describe('runtimeProxyOriginProof', () => {
  function captureReasons() {
    const reasons: unknown[] = [];
    vi.spyOn(logger, 'withFields').mockImplementation(fields => {
      reasons.push((fields as { reason?: unknown }).reason);
      return logger;
    });
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    return reasons;
  }

  it('reports a missing secret binding distinctly from a failed secret read', async () => {
    const reasons = captureReasons();
    expect(await runtimeProxyOriginProof({}, 'sandbox-1')).toBeNull();
    const failing = {
      get: () => Promise.reject(new Error('secret store unavailable')),
    };
    expect(await runtimeProxyOriginProof({ NEXTAUTH_SECRET: failing }, 'sandbox-1')).toBeNull();
    expect(reasons).toEqual(['secret_not_configured', 'secret_unavailable']);
  });
});
