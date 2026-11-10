import { describe, expect, it } from 'vitest';
import { encodeCloudflareProviderRef } from '../../sandbox-control/provider-ref.js';
import type { ControlPlaneCredentialSource } from '../../shared/control-plane-protocol.js';
import {
  hasPreviewWorkspaceBinding,
  resolvePreviewTarget,
  type PreviewSandboxScope,
  type PreviewTargetSnapshot,
} from './preview-target.js';
import type { RouteRecord, RouteState } from './routes.js';

const WORKSPACE_ID = 'worktree_11111111-1111-4111-8111-111111111111';
const SESSION_ID = 'workspace_22222222-2222-4222-8222-222222222222';

const SCOPE: PreviewSandboxScope = {
  ownerId: 'user_1',
  organizationId: 'org_1',
  scopeId: WORKSPACE_ID,
};

function credentialSource(
  overrides: Partial<ControlPlaneCredentialSource> = {}
): ControlPlaneCredentialSource {
  return {
    userId: 'user_1',
    kiloSessionId: 'kilo_session_1',
    kiloToken: 'kilo_token',
    orgId: 'org_1',
    scopeId: WORKSPACE_ID,
    ...overrides,
  };
}

function route(
  overrides: {
    sessionId?: string;
    state?: RouteState;
    credentialSource?: ControlPlaneCredentialSource | null;
    workspaceId?: ControlPlaneCredentialSource['workspaceId'];
  } = {}
): RouteRecord {
  const sessionId = overrides.sessionId ?? SESSION_ID;
  return {
    sessionId,
    spec: {
      sessionId,
      kiloSessionId: 'kilo_session_1',
      directory: `/workspace/${sessionId}`,
      attemptId: 'attempt-1',
    },
    grant: null,
    credentialSource:
      overrides.credentialSource === undefined
        ? credentialSource({
            ...(overrides.workspaceId === undefined ? {} : { workspaceId: overrides.workspaceId }),
          })
        : overrides.credentialSource,
    environment: null,
    state: overrides.state ?? 'ready',
    attemptId: 'attempt-1',
    attemptDeadlineAt: 0,
    reason: null,
  };
}

function snapshot(overrides: Partial<PreviewTargetSnapshot> = {}): PreviewTargetSnapshot {
  return {
    allocationKind: 'connected',
    providerRef: 'allocation-ref',
    provider: 'cloudflare-containers',
    logicalSandboxId: 'workspace_11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

describe('hasPreviewWorkspaceBinding', () => {
  it('requires the owner, organization and workspace scope to match', () => {
    expect(hasPreviewWorkspaceBinding([route()], SCOPE)).toBe(true);
    expect(
      hasPreviewWorkspaceBinding(
        [route({ credentialSource: credentialSource({ userId: 'other' }) })],
        SCOPE
      )
    ).toBe(false);
    expect(
      hasPreviewWorkspaceBinding(
        [route({ credentialSource: credentialSource({ orgId: 'other' }) })],
        SCOPE
      )
    ).toBe(false);
    expect(
      hasPreviewWorkspaceBinding(
        [route({ credentialSource: credentialSource({ scopeId: 'worktree_other' }) })],
        SCOPE
      )
    ).toBe(false);
  });

  it('falls back to the route session id when the source has no scope', () => {
    expect(
      hasPreviewWorkspaceBinding(
        [
          route({
            sessionId: WORKSPACE_ID,
            credentialSource: credentialSource({ scopeId: undefined }),
          }),
        ],
        SCOPE
      )
    ).toBe(true);
  });

  it('binds a sibling route even when the viewed session has no route', () => {
    const sibling = route({
      sessionId: 'workspace_33333333-3333-4333-8333-333333333333',
    });
    expect(hasPreviewWorkspaceBinding([sibling], SCOPE)).toBe(true);
  });

  it('checks the optional workspace id against the requested scope', () => {
    expect(hasPreviewWorkspaceBinding([route({ workspaceId: WORKSPACE_ID })], SCOPE)).toBe(true);
    expect(
      hasPreviewWorkspaceBinding(
        [route({ workspaceId: 'worktree_44444444-4444-4444-8444-444444444444' })],
        SCOPE
      )
    ).toBe(false);
  });

  it.each<RouteState>(['failed', 'preparing', 'ready'])(
    'ignores the %s route state: scope binding is ownership, not readiness',
    state => {
      expect(hasPreviewWorkspaceBinding([route({ state })], SCOPE)).toBe(true);
    }
  );

  it('does not bind without a stored credential source', () => {
    expect(hasPreviewWorkspaceBinding([route({ credentialSource: null })], SCOPE)).toBe(false);
    expect(hasPreviewWorkspaceBinding([], SCOPE)).toBe(false);
  });
});

describe('resolvePreviewTarget', () => {
  it('maps a creating or starting allocation to not_ready', () => {
    expect(resolvePreviewTarget(snapshot({ allocationKind: 'creating' }))).toEqual({
      status: 'not_ready',
    });
    expect(resolvePreviewTarget(snapshot({ allocationKind: 'starting' }))).toEqual({
      status: 'not_ready',
    });
  });

  it('maps a stopped or stopping allocation to not_running', () => {
    expect(resolvePreviewTarget(snapshot({ allocationKind: 'stopped' }))).toEqual({
      status: 'not_running',
    });
    expect(resolvePreviewTarget(snapshot({ allocationKind: 'stopping' }))).toEqual({
      status: 'not_running',
    });
  });

  it('fails closed not_running without a provider ref', () => {
    expect(resolvePreviewTarget(snapshot({ providerRef: null }))).toEqual({
      status: 'not_running',
    });
  });

  it('refuses vercel and the retired cloudflare runtime before returning coordinates', () => {
    expect(
      resolvePreviewTarget(snapshot({ provider: 'vercel', providerRef: 'vercel-ref' }))
    ).toEqual({ status: 'unsupported_provider' });
    expect(
      resolvePreviewTarget(snapshot({ provider: 'cloudflare', providerRef: 'persisted-ref' }))
    ).toEqual({ status: 'unsupported_provider' });
    expect(
      resolvePreviewTarget(
        snapshot({
          provider: 'vercel',
          providerRef: 'vercel-ref',
          allocationKind: 'stopped',
        })
      )
    ).toEqual({ status: 'unsupported_provider' });
    expect(resolvePreviewTarget(snapshot({ provider: 'vercel', providerRef: null }))).toEqual({
      status: 'unsupported_provider',
    });
  });

  it('returns the logical sandbox id and allocation ref for cloudflare-containers', () => {
    const ref = encodeCloudflareProviderRef({
      sandboxId: 'allocation-name',
      containment: false,
      instanceId: 'intent-1',
    });
    expect(
      resolvePreviewTarget(
        snapshot({
          provider: 'cloudflare-containers',
          providerRef: ref,
          logicalSandboxId: 'workspace_abc',
        })
      )
    ).toEqual({
      status: 'ok',
      coordinates: {
        provider: 'cloudflare-containers',
        logicalSandboxId: 'workspace_abc',
        allocationRef: ref,
      },
    });
  });
});
