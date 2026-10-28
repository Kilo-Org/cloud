import { describe, expect, it } from 'vitest';
import { encodeCloudflareProviderRef } from '../../sandbox-control/cloudflare-provider.js';
import { resolvePreviewTarget, type PreviewTargetSnapshot } from './preview-target.js';

function snapshot(overrides: Partial<PreviewTargetSnapshot> = {}): PreviewTargetSnapshot {
  return {
    routeState: 'ready',
    allocationKind: 'connected',
    providerRef: 'ses-11111111111141118111111111111111',
    provider: 'cloudflare',
    pinnedAllocationName: 'ses-11111111111141118111111111111111',
    sandboxKind: undefined,
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

  it('refuses vercel before returning any coordinates', () => {
    expect(
      resolvePreviewTarget(snapshot({ provider: 'vercel', providerRef: 'vercel-ref' }))
    ).toEqual({ status: 'unsupported_provider' });
  });

  it('refuses vercel before any route or allocation state', () => {
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

  it('fails closed not_running for an undecodable ref that is not the pinned name', () => {
    expect(
      resolvePreviewTarget(
        snapshot({
          providerRef: 'not-json',
          pinnedAllocationName: 'ses-pinned',
        })
      )
    ).toEqual({ status: 'not_running' });
  });

  it('returns cloudflare allocation name and containment from an encoded ref', () => {
    const ref = encodeCloudflareProviderRef({
      sandboxId: 'usr-shared',
      containment: true,
      instanceId: 'intent-1',
    });
    expect(resolvePreviewTarget(snapshot({ providerRef: ref }))).toEqual({
      status: 'ok',
      coordinates: {
        provider: 'cloudflare',
        allocationName: 'usr-shared',
        containment: true,
      },
    });
  });

  it('returns cloudflare pinned name and no containment for a legacy plain ref', () => {
    expect(
      resolvePreviewTarget(
        snapshot({
          providerRef: 'ses-plain',
          pinnedAllocationName: 'ses-plain',
        })
      )
    ).toEqual({
      status: 'ok',
      coordinates: {
        provider: 'cloudflare',
        allocationName: 'ses-plain',
        containment: false,
      },
    });
  });

  it('carries the pinned kind of a placed key into the cloudflare coordinates', () => {
    const placedKey = `sbx-${'a'.repeat(48)}`;
    const ref = encodeCloudflareProviderRef({
      sandboxId: placedKey,
      containment: true,
      instanceId: 'intent-1',
    });
    expect(
      resolvePreviewTarget(
        snapshot({ providerRef: ref, pinnedAllocationName: placedKey, sandboxKind: 'isolated' })
      )
    ).toEqual({
      status: 'ok',
      coordinates: {
        provider: 'cloudflare',
        allocationName: placedKey,
        containment: true,
        sandboxKind: 'isolated',
      },
    });
  });

  it('returns the logical sandbox id for cloudflare-containers', () => {
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
          pinnedAllocationName: 'allocation-name',
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
