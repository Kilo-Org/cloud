import { describe, expect, it } from 'vitest';
import { resolveSandboxNamespace, type SandboxKind } from '../sandbox-placement.js';
import type { Env } from '../types.js';
import {
  createCloudflareProviderAdapter,
  encodeCloudflareProviderRef,
} from './cloudflare-provider.js';
import { ProviderCreationError } from './provider.js';

describe('retired Cloudflare runtimes', () => {
  it.each([
    { sandboxId: 'dind-abcdef', containment: true },
    { sandboxId: 'crv-abcdef', containment: true },
    { sandboxId: 'usr-abcdef', containment: false },
    { sandboxId: 'ses-abcdef', containment: false },
    { sandboxId: `sbx-${'a'.repeat(48)}`, containment: false, sandboxKind: 'shared' },
    { sandboxId: `sbx-${'b'.repeat(48)}`, containment: true, sandboxKind: 'code-review' },
  ] satisfies { sandboxId: string; containment: boolean; sandboxKind?: SandboxKind }[])(
    'confirms stop and terminal observation for $sandboxId',
    async ({ sandboxId, containment, ...placement }) => {
      const resolveNamespace = () =>
        resolveSandboxNamespace({} as Env, { sandboxId, contained: containment, ...placement });
      const adapter = createCloudflareProviderAdapter({
        sandboxId,
        getSandbox: () => {
          resolveNamespace();
          throw new Error('Retired namespace unexpectedly resolved');
        },
        destroy: async () => {
          resolveNamespace();
          throw new Error('Retired namespace unexpectedly resolved');
        },
      });
      const ref = encodeCloudflareProviderRef({ sandboxId, containment, instanceId: 'attempt-1' });
      await expect(adapter.stop(ref)).resolves.toBe('terminal');
      await expect(adapter.observe(ref)).resolves.toEqual({ status: 'terminal', providerRef: ref });
      if (!containment) await expect(adapter.stop(sandboxId)).resolves.toBe('terminal');
    }
  );

  it('fails creation permanently instead of retrying a retired runtime', async () => {
    const sandboxId = 'ses-abcdef';
    const retired = () =>
      resolveSandboxNamespace({} as Env, { sandboxId, contained: false }) as never;
    const adapter = createCloudflareProviderAdapter({
      sandboxId,
      getSandbox: retired,
      destroy: async () => retired(),
    });
    const ref = encodeCloudflareProviderRef({ sandboxId, containment: false, instanceId: 'a-1' });
    const launch = adapter.launch(ref, { command: { argv: ['true'] }, env: {} });
    await expect(launch).rejects.toBeInstanceOf(ProviderCreationError);
    await expect(launch).rejects.toMatchObject({ permanentReason: 'invalid_configuration' });
  });
});
