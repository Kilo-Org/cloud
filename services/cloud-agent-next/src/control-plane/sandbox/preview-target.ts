import type { AgentSandboxProvider } from '../../types.js';
import { decodeCloudflareProviderRef } from '../../sandbox-control/cloudflare-provider.js';
import type { AllocationKind } from './allocation.js';
import type { RouteState } from './routes.js';

export type PreviewProviderCoordinates =
  | {
      provider: 'cloudflare';
      allocationName: string;
      containment: boolean;
    }
  | {
      provider: 'cloudflare-containers';
      logicalSandboxId: string;
      allocationRef: string;
    };

export type PreviewTargetResult =
  | { status: 'not_ready' }
  | { status: 'not_running' }
  | { status: 'unsupported_provider' }
  | { status: 'ok'; coordinates: PreviewProviderCoordinates };

export type ResolvedPreviewTarget = { status: 'ineligible' } | PreviewTargetResult;

export type PreviewTargetSnapshot = {
  routeState: RouteState | null;
  allocationKind: AllocationKind;
  providerRef: string | null;
  provider: AgentSandboxProvider;
  pinnedAllocationName: string;
  logicalSandboxId: string;
};

export function resolvePreviewTarget(snapshot: PreviewTargetSnapshot): PreviewTargetResult {
  if (snapshot.provider === 'vercel') return { status: 'unsupported_provider' };

  // No route means this session is not routed to the sandbox.
  if (snapshot.routeState === null || snapshot.routeState === 'failed') {
    return { status: 'not_running' };
  }
  if (snapshot.routeState === 'preparing') return { status: 'not_ready' };

  if (snapshot.allocationKind === 'creating' || snapshot.allocationKind === 'starting') {
    return { status: 'not_ready' };
  }
  if (snapshot.allocationKind === 'stopped' || snapshot.allocationKind === 'stopping') {
    return { status: 'not_running' };
  }
  if (snapshot.providerRef === null) return { status: 'not_running' };

  if (snapshot.provider === 'cloudflare-containers') {
    return {
      status: 'ok',
      coordinates: {
        provider: 'cloudflare-containers',
        logicalSandboxId: snapshot.logicalSandboxId,
        allocationRef: snapshot.providerRef,
      },
    };
  }

  const decoded = decodeCloudflareProviderRef(snapshot.providerRef);
  if (decoded === null && snapshot.providerRef !== snapshot.pinnedAllocationName) {
    return { status: 'not_running' };
  }
  return {
    status: 'ok',
    coordinates: {
      provider: 'cloudflare',
      allocationName: decoded?.sandboxId ?? snapshot.pinnedAllocationName,
      containment: decoded?.containment ?? false,
    },
  };
}
