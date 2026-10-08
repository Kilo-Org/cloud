import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContainerConcurrencyLimitError } from '../container-concurrency.js';
import {
  parseSandboxBillingInput,
  type MeteredSandboxInstance,
  type SandboxBillingAdmissionResult,
} from '../container-usage-context.js';
import type { SandboxContainers } from '../sandbox-containers/SandboxContainers.js';
import type { VercelSandboxRuntimeConfig } from '../agent-sandbox/vercel/vercel-runtime-config.js';
import { VercelSandboxRestError } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { createCloudflareProviderAdapter } from './cloudflare-provider.js';
import { createCloudflareContainersProviderAdapter } from './cloudflare-containers-provider.js';
import { createVercelProviderAdapter } from './vercel-provider.js';
import {
  ProviderCreationError,
  type ProviderAdapter,
  type ProviderCreateIntent,
} from './provider.js';

const SANDBOX_ID = 'ses-abcdef';
const billing = parseSandboxBillingInput({
  sandboxId: SANDBOX_ID,
  subject: { type: 'user', id: 'user-1' },
  actor: { type: 'user', id: 'user-1' },
  sessionId: 'workspace_test',
  metadata: { origin: 'cloud-agent' },
  enforcementRequested: true,
});
const intent: ProviderCreateIntent = { intentId: 'attempt', createdAt: 0, billing };
const config: VercelSandboxRuntimeConfig = {
  accessToken: 'test-token',
  teamId: 'team',
  projectId: 'project',
  snapshotId: 'snapshot',
  runtimeBuildId: 'build',
  runtime: 'node24',
  initialTimeoutMs: 60_000,
  extendDurationMs: 60_000,
};

function cloudflareProvider(
  kind: 'cloudflare' | 'cloudflare-containers',
  admit: () => Promise<SandboxBillingAdmissionResult>
): ProviderAdapter {
  if (kind === 'cloudflare') {
    const sandbox: Partial<MeteredSandboxInstance> = {
      isBillingBlocked: async () => false,
      ensureBillingAdmission: admit,
    } satisfies Pick<MeteredSandboxInstance, 'isBillingBlocked' | 'ensureBillingAdmission'>;
    return createCloudflareProviderAdapter({
      sandboxId: SANDBOX_ID,
      getSandbox: () => sandbox as MeteredSandboxInstance,
      destroy: async () => {},
    });
  }
  const container: object = {
    isBillingBlocked: async () => false,
    ensureBillingAdmission: admit,
  } satisfies Pick<SandboxContainers, 'isBillingBlocked' | 'ensureBillingAdmission'>;
  return createCloudflareContainersProviderAdapter({
    logicalSandboxId: SANDBOX_ID,
    allocationName: SANDBOX_ID,
    getContainer: () => container as DurableObjectStub<SandboxContainers>,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe.each(['cloudflare', 'cloudflare-containers'] as const)('%s creation causes', kind => {
  it('retries shadow billing configuration with a fresh handle and unchanged attribution', async () => {
    const error = Object.assign(new Error('Durable Object reset'), { retryable: true });
    const failed = {
      isBillingBlocked: vi.fn().mockResolvedValue(false),
      configureBilling: vi.fn().mockRejectedValue(error),
    };
    const recovered = { configureBilling: vi.fn().mockResolvedValue(undefined) };
    const resolveHandle = vi
      .fn()
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(failed)
      .mockReturnValue(recovered);
    const provider =
      kind === 'cloudflare'
        ? createCloudflareProviderAdapter({
            sandboxId: SANDBOX_ID,
            getSandbox: resolveHandle,
            destroy: async () => {},
          })
        : createCloudflareContainersProviderAdapter({
            logicalSandboxId: SANDBOX_ID,
            allocationName: SANDBOX_ID,
            getContainer: resolveHandle,
          });

    await expect(
      provider.create({ ...intent, billing: { ...billing, enforcementRequested: false } })
    ).resolves.toMatchObject({ providerRef: expect.any(String) });

    expect(resolveHandle).toHaveBeenCalledTimes(3);
    expect(failed.configureBilling).toHaveBeenCalledOnce();
    expect(recovered.configureBilling).toHaveBeenCalledOnce();
    expect(recovered.configureBilling.mock.calls[0]).toEqual(failed.configureBilling.mock.calls[0]);
  });

  it.each([
    { flags: { retryable: true }, attempts: 3 },
    { flags: { retryable: false }, attempts: 1 },
    { flags: { overloaded: true }, attempts: 1 },
  ])(
    'propagates shadow configuration failure after $attempts attempts: $flags',
    async ({ flags, attempts }) => {
      const error = Object.assign(new Error('Billing configuration failed'), flags);
      const configureBilling = vi.fn().mockRejectedValue(error);
      const resolveHandle = vi.fn(() => ({
        isBillingBlocked: async () => false,
        configureBilling,
      }));
      const provider =
        kind === 'cloudflare'
          ? createCloudflareProviderAdapter({
              sandboxId: SANDBOX_ID,
              getSandbox: () => resolveHandle() as unknown as MeteredSandboxInstance,
              destroy: async () => {},
            })
          : createCloudflareContainersProviderAdapter({
              logicalSandboxId: SANDBOX_ID,
              allocationName: SANDBOX_ID,
              getContainer: () =>
                resolveHandle() as unknown as DurableObjectStub<SandboxContainers>,
            });

      await expect(
        provider.create({ ...intent, billing: { ...billing, enforcementRequested: false } })
      ).rejects.toBe(error);

      expect(configureBilling).toHaveBeenCalledTimes(attempts);
      expect(resolveHandle).toHaveBeenCalledTimes(attempts + 1);
    }
  );

  it('preserves RPC-wrapped quota denial instead of converting it to a meter outage', async () => {
    const denial = new Error(
      `remote RPC: ${new ContainerConcurrencyLimitError('personal', 20).message}`
    );
    const provider = cloudflareProvider(kind, async () => {
      throw denial;
    });
    await expect(provider.create(intent)).rejects.toBe(denial);
  });
  it.each(['insufficient_credits', 'stopping', 'meter_unavailable'] as const)(
    'preserves %s independently of unsafe provider text',
    async code => {
      const provider = cloudflareProvider(kind, async () => ({
        success: false,
        code,
        message: 'raw-sensitive-provider-detail',
      }));
      const error = await provider.create(intent).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ProviderCreationError);
      expect(error).toMatchObject({
        code,
        permanentReason: code === 'insufficient_credits' ? 'billing_blocked' : null,
      });
      expect(error).not.toMatchObject({ message: 'raw-sensitive-provider-detail' });
    }
  );

  it('does not promote a transport exception containing billing text to insufficient credits', async () => {
    const provider = cloudflareProvider(kind, async () => {
      throw new Error('insufficient credits 402');
    });
    await expect(provider.create(intent)).rejects.toMatchObject({
      code: 'meter_unavailable',
      permanentReason: null,
    });
  });

  it('permits a later create after stopping or the meter outage clears', async () => {
    let result: SandboxBillingAdmissionResult = {
      success: false,
      code: 'stopping',
      message: 'stopping',
    };
    const provider = cloudflareProvider(kind, async () => result);
    await expect(provider.create(intent)).rejects.toMatchObject({ code: 'stopping' });
    result = { success: true };
    await expect(provider.create(intent)).resolves.toMatchObject({
      providerRef: expect.any(String),
    });
  });

  it('classifies a locally invalid billing configuration without admitting work', async () => {
    const admit = vi.fn<() => Promise<SandboxBillingAdmissionResult>>();
    const provider = cloudflareProvider(kind, admit);
    await expect(
      provider.create({ ...intent, billing: { ...billing, subject: { type: 'user', id: '' } } })
    ).rejects.toMatchObject({
      code: 'invalid_configuration',
      permanentReason: 'invalid_configuration',
    });
    expect(admit).not.toHaveBeenCalled();
  });
});

describe('Vercel creation causes', () => {
  it('classifies missing local configuration without a provider request', async () => {
    const provider = createVercelProviderAdapter({ sandboxName: SANDBOX_ID });
    await expect(provider.create(intent)).rejects.toMatchObject({
      code: 'invalid_configuration',
      permanentReason: 'invalid_configuration',
    });
  });

  it.each([
    { ...config, accessToken: '' },
    { ...config, snapshotId: '' },
    { ...config, initialTimeoutMs: 0 },
  ])('classifies proven local configuration/request validation', async invalidConfig => {
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', request);
    const provider = createVercelProviderAdapter({
      sandboxName: SANDBOX_ID,
      config: invalidConfig,
    });
    await expect(provider.create(intent)).rejects.toMatchObject({
      code: 'invalid_configuration',
      permanentReason: 'invalid_configuration',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([400, 401, 402, 403, 404, 409, 429, 500, 503])(
    'does not infer permanence from HTTP %s',
    async status => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('insufficient credits invalid configuration raw-detail', { status })
        );
      vi.stubGlobal('fetch', request);
      const provider = createVercelProviderAdapter({ sandboxName: SANDBOX_ID, config });
      const error = await provider.create(intent).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(VercelSandboxRestError);
      expect(error).toMatchObject({ kind: 'request_failed', status });
      expect(error).not.toBeInstanceOf(ProviderCreationError);
    }
  );

  it('keeps network failure transient without matching its text', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('insufficient credits invalid configuration'))
    );
    const provider = createVercelProviderAdapter({ sandboxName: SANDBOX_ID, config });
    await expect(provider.create(intent)).rejects.toMatchObject({ kind: 'request_failed' });
  });
});
