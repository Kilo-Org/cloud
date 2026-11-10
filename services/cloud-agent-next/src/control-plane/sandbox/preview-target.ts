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
