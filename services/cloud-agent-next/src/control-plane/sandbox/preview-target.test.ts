import { describe, expect, it } from 'vitest';
import { encodeCloudflareProviderRef } from '../../sandbox-control/provider-ref.js';
import { resolvePreviewTarget, type PreviewTargetSnapshot } from './preview-target.js';

function snapshot(overrides: Partial<PreviewTargetSnapshot> = {}): PreviewTargetSnapshot {
  return {
    routeState: 'ready',
    allocationKind: 'connected',
    providerRef: 'allocation-ref',
    provider: 'cloudflare-containers',
    logicalSandboxId: 'workspace_11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

describe('resolvePreviewTarget', () => {
  it('reports a session with no route on the sandbox as not_running', () => {
    expect(resolvePreviewTarget(snapshot({ routeState: null }))).toEqual({
      status: 'not_running',
    });
  });

  it('maps a preparing route and a creating allocation to not_ready', () => {
    expect(resolvePreviewTarget(snapshot({ routeState: 'preparing' }))).toEqual({
      status: 'not_ready',
    });
    expect(resolvePreviewTarget(snapshot({ allocationKind: 'creating' }))).toEqual({
      status: 'not_ready',
    });
    expect(resolvePreviewTarget(snapshot({ allocationKind: 'starting' }))).toEqual({
      status: 'not_ready',
    });
  });

  it('maps a failed route and a stopped allocation to not_running', () => {
    expect(resolvePreviewTarget(snapshot({ routeState: 'failed' }))).toEqual({
      status: 'not_running',
    });
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
          routeState: 'ready',
          allocationKind: 'stopped',
        })
      )
    ).toEqual({ status: 'unsupported_provider' });
    expect(
      resolvePreviewTarget(snapshot({ provider: 'vercel', providerRef: null, routeState: null }))
    ).toEqual({ status: 'unsupported_provider' });
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
