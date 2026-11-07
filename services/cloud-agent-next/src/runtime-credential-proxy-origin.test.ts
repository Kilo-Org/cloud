import { describe, expect, it } from 'vitest';
import {
  configuredVercelRuntimeProxyForwardUrl,
  runtimeCredentialProxyOriginSchema,
  sameRuntimeProxyOriginBinding,
  type RuntimeProxyControlBinding,
} from './runtime-credential-proxy-origin.js';

function binding(overrides: Partial<RuntimeProxyControlBinding> = {}): RuntimeProxyControlBinding {
  return {
    plane: 'control',
    logicalSandboxId: 'workspace_test',
    allocationId: 'allocation-1',
    provider: 'cloudflare-containers',
    providerInstanceId: '{"sandboxId":"workspace_test","containment":true,"instanceId":"a"}',
    connectionId: 'connection-1',
    wrapperInstanceId: 'wrapper-1',
    ...overrides,
  };
}

describe('runtime credential proxy origins', () => {
  it('parses the trusted native and Vercel shapes only', () => {
    expect(
      runtimeCredentialProxyOriginSchema.parse({
        type: 'cloudflare-containers',
        containerId: 'container-1',
        allocationRef: '{"sandboxId":"workspace_test"}',
      })
    ).toEqual({
      type: 'cloudflare-containers',
      containerId: 'container-1',
      allocationRef: '{"sandboxId":"workspace_test"}',
    });
    expect(
      runtimeCredentialProxyOriginSchema.parse({
        type: 'vercel',
        oidcToken: 'token',
        logicalSandboxId: 'workspace_test',
      })
    ).toEqual({
      type: 'vercel',
      oidcToken: 'token',
      logicalSandboxId: 'workspace_test',
    });
    expect(
      runtimeCredentialProxyOriginSchema.safeParse({
        type: 'cloudflare-containers',
        containerId: 'container-1',
        allocationRef: 'ref',
        callerSupplied: true,
      }).success
    ).toBe(false);
    expect(
      runtimeCredentialProxyOriginSchema.safeParse({ type: 'vercel', oidcToken: '' }).success
    ).toBe(false);
  });

  it('builds the exact Vercel forwardURL used as the OIDC audience', () => {
    expect(
      configuredVercelRuntimeProxyForwardUrl(
        { WORKER_URL: 'https://worker.example.com' },
        'workspace_test'
      )
    ).toBe('https://worker.example.com/runtime-credential-proxy/vercel/workspace_test');
    expect(
      configuredVercelRuntimeProxyForwardUrl(
        { WORKER_URL: 'https://worker.example.com' },
        'workspace_/../test'
      )
    ).toBeNull();
    expect(
      configuredVercelRuntimeProxyForwardUrl(
        { WORKER_URL: 'http://worker.example.com' },
        'workspace_test'
      )
    ).toBeNull();
    expect(
      configuredVercelRuntimeProxyForwardUrl(
        { WORKER_URL: 'https://user:pass@worker.example.com' },
        'workspace_test'
      )
    ).toBeNull();
  });

  it('compares the reconnect-safe control binding, not the socket connection', () => {
    const left = binding();
    expect(sameRuntimeProxyOriginBinding(left, binding({ connectionId: 'connection-2' }))).toBe(
      true
    );
    for (const change of [
      { allocationId: 'allocation-2' },
      { providerInstanceId: 'other-ref' },
      { wrapperInstanceId: 'wrapper-2' },
      { logicalSandboxId: 'workspace_other' },
      { provider: 'vercel' as const },
    ])
      expect(sameRuntimeProxyOriginBinding(left, binding(change))).toBe(false);
  });
});
