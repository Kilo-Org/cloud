import { describe, expect, it } from 'vitest';
import { providerSupports } from '@kilocode/worker-utils/sandbox-provider-capabilities';
import { AGENT_SANDBOX_PROVIDERS, PROVIDER_DESCRIPTORS } from '../../shared/sandbox-provider.js';
import { ProviderCreationError, type ProviderAdapter } from '../../sandbox-control/provider.js';
import type { AgentSandboxProvider, Env } from '../../types.js';
import {
  createProviderAdapter,
  type ProviderAdapterDeps,
  type StoredProviderPin,
} from './provider-adapters.js';

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

function pin(provider: AgentSandboxProvider, extra: Partial<StoredProviderPin> = {}) {
  return {
    provider,
    allocationName: null,
    configuration: null,
    locator: null,
    billing: null,
    containment: null,
    ...extra,
  } satisfies StoredProviderPin;
}

/** A configured pin for each provider: Vercel needs a BYOC source. */
const CONFIGURED_PINS: Record<AgentSandboxProvider, StoredProviderPin> = {
  cloudflare: pin('cloudflare'),
  vercel: pin('vercel', {
    allocationName: 'ses-abcdef-1',
    byoc: { userId: 'user-1', credentialId: '22222222-2222-4222-8222-222222222222' },
  }),
  'cloudflare-containers': pin('cloudflare-containers'),
};

function members(adapter: ProviderAdapter) {
  return {
    workspaceSnapshots: adapter.workspaceSnapshots !== undefined,
    environmentSnapshots: adapter.environmentSnapshots !== undefined,
    meteredBilling:
      adapter.isBillingBlocked !== undefined && adapter.getBillingProjection !== undefined,
    networkPolicyCredentials: adapter.applyContainedCredentials !== undefined,
  };
}

describe('provider adapters agree with the capability table and descriptors', () => {
  it.each(AGENT_SANDBOX_PROVIDERS)('%s', provider => {
    const adapter = createProviderAdapter(CONFIGURED_PINS[provider], deps);
    expect(members(adapter)).toEqual({
      workspaceSnapshots: providerSupports(provider, 'workspaceSnapshots'),
      environmentSnapshots: providerSupports(provider, 'environmentSnapshots'),
      meteredBilling: providerSupports(provider, 'meteredBilling'),
      networkPolicyCredentials:
        PROVIDER_DESCRIPTORS[provider].credentialTransport === 'network-policy',
    });
  });

  // A legacy platform Vercel pin has no BYOC source and no compute. Its stub
  // has no optional member, so the Sandbox DO reads the snapshot members from
  // the adapter, not from the table.
  it('builds a Vercel stub without optional members when the pin has no BYOC source', () => {
    const adapter = createProviderAdapter(pin('vercel'), deps);
    expect(members(adapter)).toEqual({
      workspaceSnapshots: false,
      environmentSnapshots: false,
      meteredBilling: false,
      networkPolicyCredentials: false,
    });
  });

  it('rejects an unknown provider as an invalid configuration', () => {
    const unknown = pin('unknown' as AgentSandboxProvider);
    let thrown: unknown;
    try {
      createProviderAdapter(unknown, deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderCreationError);
    expect((thrown as ProviderCreationError).code).toBe('invalid_configuration');
  });
});
