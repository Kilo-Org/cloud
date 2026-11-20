import type { SandboxBillingInput } from '../../container-usage-context.js';
import {
  createByocVercelProviderAdapter,
  unavailableVercelProviderAdapter,
  type ByocVercelSource,
} from '../../byoc/vercel-provider.js';
import { createCloudflareContainersProviderAdapter } from '../../sandbox-control/cloudflare-containers-provider.js';
import type { CredentialContainmentRequirements } from '../../sandbox-control/credential-containment.js';
import {
  ProviderCreationError,
  type ProviderAdapter,
  type SandboxProviderConfiguration,
} from '../../sandbox-control/provider.js';
import { createRetiredCloudflareProviderAdapter } from '../../sandbox-control/retired-cloudflare-provider.js';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import type { SandboxContainers } from '../../sandbox-containers/SandboxContainers.js';
import type { VercelProviderLocator } from '../../sandbox-control/vercel-provider.js';
import type { SandboxKind } from '../../sandbox-placement.js';
import type { AgentSandboxProvider, Env } from '../../types.js';

/**
 * The provider registry for adapter construction. Provider facts are in
 * `PROVIDER_DESCRIPTORS` (`src/shared/sandbox-provider.ts`) and feature
 * support is in the worker-utils capability table. A new provider adds one
 * `case` here; the exhaustive `switch` does not compile without it.
 */

export type StoredProviderPin = {
  byoc?: ByocVercelSource;
  provider: AgentSandboxProvider;
  allocationName: string | null;
  configuration: SandboxProviderConfiguration | null;
  locator: VercelProviderLocator | null;
  billing: SandboxBillingInput | null;
  containment: CredentialContainmentRequirements | null;
  /** Stored kind of a placed key. Legacy prefixed keys have none. */
  sandboxKind?: SandboxKind;
  egressAllowlist?: string[];
  egressAudit?: boolean;
};

/** What an adapter needs from the Sandbox DO that owns the pin. */
export type ProviderAdapterDeps = {
  env: Env;
  sandboxId: string;
  persistRuntimeLocator: (allocationName: string, locator: VercelProviderLocator) => Promise<void>;
  readContainedGrants: () => Promise<readonly SessionCredentialGrant[]>;
  readAcceptedRuntimeProxyHandles: () => Promise<ReadonlyMap<string, readonly string[]>>;
  getSandboxContainer: (id: string) => DurableObjectStub<SandboxContainers>;
};

export function createProviderAdapter(
  pin: StoredProviderPin,
  deps: ProviderAdapterDeps
): ProviderAdapter {
  const allocationName = pin.allocationName ?? deps.sandboxId;
  switch (pin.provider) {
    case 'vercel': {
      const resources =
        pin.configuration?.provider === 'vercel' ? pin.configuration.resources : undefined;
      if (pin.byoc) {
        return createByocVercelProviderAdapter({
          env: deps.env,
          source: pin.byoc,
          sandboxName: allocationName,
          resources,
          locator: pin.locator,
          persistRuntimeLocator: locator => deps.persistRuntimeLocator(allocationName, locator),
          readContainedGrants: deps.readContainedGrants,
          readAcceptedRuntimeProxyHandles: deps.readAcceptedRuntimeProxyHandles,
        });
      }
      return unavailableVercelProviderAdapter();
    }
    case 'cloudflare-containers': {
      const instance =
        pin.configuration?.provider === 'cloudflare-containers'
          ? pin.configuration.instance
          : undefined;
      return createCloudflareContainersProviderAdapter({
        logicalSandboxId: deps.sandboxId,
        allocationName,
        ...(instance === undefined ? {} : { instance }),
        ...(pin.egressAllowlist === undefined ? {} : { egressAllowlist: pin.egressAllowlist }),
        ...(pin.egressAudit === true ? { egressAudit: true } : {}),
        getContainer: deps.getSandboxContainer,
      });
    }
    case 'cloudflare':
      return createRetiredCloudflareProviderAdapter();
    default: {
      void (pin.provider satisfies never);
      throw new ProviderCreationError('invalid_configuration');
    }
  }
}
