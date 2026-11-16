import { providerSupports } from '@kilocode/worker-utils/sandbox-provider-capabilities';
import type { AgentSandboxProvider } from '../../types.js';
import type { AllocationKind } from './allocation.js';
import type { RouteRecord } from './routes.js';

export type PreviewSandboxScope = {
  ownerId: string;
  organizationId: string | null;
  scopeId: string;
};

export function hasPreviewWorkspaceBinding(
  routes: readonly RouteRecord[],
  scope: PreviewSandboxScope
): boolean {
  return routes.some(route => {
    const source = route.credentialSource;
    return (
      source !== null &&
      source.userId === scope.ownerId &&
      (source.orgId ?? null) === scope.organizationId &&
      (source.scopeId ?? route.sessionId) === scope.scopeId &&
      (source.workspaceId === undefined || source.workspaceId === scope.scopeId)
    );
  });
}

/**
 * Where the Worker sends a preview request. `transport` picks the upstream in
 * `src/preview/upstreams.ts`, so the route never compares provider names.
 * `allocationRef` fences the preview cookie to one allocation.
 */
export type PreviewProviderCoordinates =
  | {
      transport: 'durable-object';
      provider: 'cloudflare-containers';
      logicalSandboxId: string;
      allocationRef: string;
    }
  | {
      transport: 'wrapper-tunnel';
      provider: AgentSandboxProvider;
      logicalSandboxId: string;
      /** The allocation id: it names the `PreviewTunnel` Durable Object. */
      allocationRef: string;
    };

export type PreviewTransport = PreviewProviderCoordinates['transport'];

export type PreviewTargetResult =
  | { status: 'not_ready' }
  | { status: 'not_running' }
  | { status: 'unsupported_provider' }
  | { status: 'ok'; coordinates: PreviewProviderCoordinates };

export type ResolvedPreviewTarget = { status: 'ineligible' } | PreviewTargetResult;

export type PreviewTargetSnapshot = {
  allocationKind: AllocationKind;
  allocationId: string | null;
  providerRef: string | null;
  provider: AgentSandboxProvider;
  logicalSandboxId: string;
};

/**
 * A provider with a private network path to its sandbox. Every other provider
 * reaches the dev server through the wrapper's preview tunnel.
 */
function privatePathCoordinates(snapshot: PreviewTargetSnapshot): PreviewTargetResult | undefined {
  if (snapshot.provider !== 'cloudflare-containers') return undefined;
  if (snapshot.providerRef === null) return { status: 'not_running' };
  return {
    status: 'ok',
    coordinates: {
      transport: 'durable-object',
      provider: 'cloudflare-containers',
      logicalSandboxId: snapshot.logicalSandboxId,
      allocationRef: snapshot.providerRef,
    },
  };
}

export function resolvePreviewTarget(snapshot: PreviewTargetSnapshot): PreviewTargetResult {
  // The retired Cloudflare Sandbox runtime is not started for any allocation,
  // including a persisted one.
  if (!providerSupports(snapshot.provider, 'preview')) {
    return { status: 'unsupported_provider' };
  }

  if (snapshot.allocationKind === 'creating' || snapshot.allocationKind === 'starting') {
    return { status: 'not_ready' };
  }
  if (snapshot.allocationKind === 'stopped' || snapshot.allocationKind === 'stopping') {
    return { status: 'not_running' };
  }

  const privatePath = privatePathCoordinates(snapshot);
  if (privatePath !== undefined) return privatePath;
  if (snapshot.allocationId === null) return { status: 'not_running' };
  return {
    status: 'ok',
    coordinates: {
      transport: 'wrapper-tunnel',
      provider: snapshot.provider,
      logicalSandboxId: snapshot.logicalSandboxId,
      allocationRef: snapshot.allocationId,
    },
  };
}
