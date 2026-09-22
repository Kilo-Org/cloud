import type { ByocVercelOwner } from './vercel-owner.js';
import type { Env } from '../types.js';
import type { ProviderAdapter } from '../sandbox-control/provider.js';
import type { VercelSandboxResources } from '@kilocode/worker-utils/sandbox-allocation';
import type { SessionCredentialGrant } from '../sandbox-control/session-credentials.js';
import {
  createVercelProviderAdapter,
  type VercelProviderLocator,
} from '../sandbox-control/vercel-provider.js';
import { VercelSandboxRestError } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import {
  ByocCredentialMissingError,
  ByocVercelNotReadyError,
  resolveByocVercelAccessConfig,
  resolveByocVercelRuntimeConfig,
  projectByocVercelSnapshotMissing,
  type ByocVercelRuntimeSnapshot,
} from './vercel-credential-resolver.js';

export type ByocVercelSource = ByocVercelOwner & { credentialId: string };

export class ByocVercelProviderError extends Error {
  constructor(
    readonly reason:
      | 'byoc_credential_missing'
      | 'byoc_vercel_not_ready'
      | 'byoc_vercel_forbidden'
      | 'byoc_vercel_capacity'
      | 'byoc_vercel_snapshot_missing'
  ) {
    super(reason);
    this.name = 'ByocVercelProviderError';
  }
}

/** Resolve customer credentials for each operation. Never persist a decrypted token. */
export function createByocVercelProviderAdapter(deps: {
  env: Env;
  source: ByocVercelSource;
  sandboxName: string;
  resources?: VercelSandboxResources;
  locator?: VercelProviderLocator | null;
  readContainedGrants: () => Promise<readonly SessionCredentialGrant[]>;
}): ProviderAdapter {
  async function accessAdapter() {
    const config = await resolveByocVercelAccessConfig(deps.env, deps.source);
    return createVercelProviderAdapter({
      ...deps,
      config: { ...config, ...deps.locator, resources: deps.resources },
    });
  }

  return {
    ensureBillingAdmission: async () => {},
    async create(intent) {
      let snapshot: ByocVercelRuntimeSnapshot | undefined;
      try {
        const config = await resolveByocVercelRuntimeConfig(deps.env, deps.source, value => {
          snapshot = value;
        });
        const adapter = createVercelProviderAdapter({
          ...deps,
          config: { ...config, resources: deps.resources },
        });
        return await adapter.create(intent);
      } catch (error) {
        if (error instanceof ByocCredentialMissingError)
          throw new ByocVercelProviderError(error.code);
        if (error instanceof ByocVercelNotReadyError) throw new ByocVercelProviderError(error.code);
        if (error instanceof VercelSandboxRestError) {
          if (error.status === 403 || error.status === 401)
            throw new ByocVercelProviderError('byoc_vercel_forbidden');
          if (error.status === 429) throw new ByocVercelProviderError('byoc_vercel_capacity');
          if (error.status === 404 && snapshot) {
            await projectByocVercelSnapshotMissing(deps.env, snapshot);
            throw new ByocVercelProviderError('byoc_vercel_snapshot_missing');
          }
        }
        throw error;
      }
    },
    launch: async (ref, env, options) => (await accessAdapter()).launch(ref, env, options),
    observe: async (ref, intent) => (await accessAdapter()).observe(ref, intent),
    stop: async (ref, intent) => (await accessAdapter()).stop(ref, intent),
    ensureLeaseAtLeast: async (ref, ms) => (await accessAdapter()).ensureLeaseAtLeast(ref, ms),
    logs: async ref => (await accessAdapter()).logs(ref),
    async applyContainedCredentials(ref, grants) {
      const adapter = await accessAdapter();
      if (!adapter.applyContainedCredentials)
        throw new Error('Vercel credential containment is unavailable');
      await adapter.applyContainedCredentials(ref, grants);
    },
  };
}

/** A retired platform pin remains readable but has no compute authority. */
export function unavailableVercelProviderAdapter(): ProviderAdapter {
  const unavailable = async (): Promise<never> => {
    throw new ByocVercelProviderError('byoc_credential_missing');
  };
  return {
    ensureBillingAdmission: unavailable,
    create: unavailable,
    launch: unavailable,
    observe: unavailable,
    stop: unavailable,
    ensureLeaseAtLeast: unavailable,
    logs: unavailable,
  };
}
