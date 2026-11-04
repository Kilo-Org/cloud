import type { AgentSandboxProvider } from '../../types.js';
import type { AllocationKind } from './allocation.js';
import type { RouteState } from './routes.js';

export type PreviewProviderCoordinates = {
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
  logicalSandboxId: string;
};

export function resolvePreviewTarget(snapshot: PreviewTargetSnapshot): PreviewTargetResult {
  // Vercel has no preview upstream, and the retired Cloudflare Sandbox runtime
  // is not started for any allocation, including a persisted one.
  if (snapshot.provider === 'vercel' || snapshot.provider === 'cloudflare') {
    return { status: 'unsupported_provider' };
  }

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

  return {
    status: 'ok',
    coordinates: {
      provider: 'cloudflare-containers',
      logicalSandboxId: snapshot.logicalSandboxId,
      allocationRef: snapshot.providerRef,
    },
  };
}
