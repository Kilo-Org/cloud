import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types.js';
import { createProviderAdapter, type ProviderAdapterDeps } from './provider-adapters.js';

const byocAdapter = vi.hoisted(() => vi.fn((_deps: unknown) => ({})));
vi.mock('../../byoc/vercel-provider.js', () => ({ createByocVercelProviderAdapter: byocAdapter }));

const unused = async (): Promise<never> => {
  throw new Error('not used at construction');
};

const deps: ProviderAdapterDeps = {
  env: {} as Env,
  sandboxId: 'ses-abcdef',
  persistRuntimeLocator: unused,
  readContainedGrants: unused,
  readAcceptedRuntimeProxyHandles: unused,
  getSandboxContainer: () => {
    throw new Error('not used at construction');
  },
};

const vercelPin = {
  provider: 'vercel' as const,
  allocationName: 'ses-abcdef-1',
  configuration: null,
  locator: null,
  billing: null,
  containment: null,
  byoc: { userId: 'user-1', credentialId: '22222222-2222-4222-8222-222222222222' },
};

describe('Vercel adapter egress wiring', () => {
  it('passes the pin allowlist and the logical sandbox id', () => {
    createProviderAdapter({ ...vercelPin, egressAllowlist: ['example.com'] }, deps);
    expect(byocAdapter).toHaveBeenLastCalledWith(
      expect.objectContaining({
        restrictedEgress: { allowlist: ['example.com'], logicalSandboxId: 'ses-abcdef' },
      })
    );
  });

  it('passes no restriction for a pin without an allowlist', () => {
    createProviderAdapter(vercelPin, deps);
    expect(byocAdapter.mock.lastCall?.[0]).not.toHaveProperty('restrictedEgress');
  });
});
