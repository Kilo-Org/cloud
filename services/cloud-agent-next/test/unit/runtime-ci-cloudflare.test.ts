import { expect, it } from 'vitest';
import {
  assertDeployedSourceOrder,
  registryDigest,
  verifyManagedBase,
} from '../../scripts/runtime-ci-cloudflare.js';
import type { BaseEvidence } from '../../scripts/runtime-ci-release.js';
import { RUNTIME_BASE_ABI } from '../../src/shared/runtime-release.js';

const accountId = 'a'.repeat(32);
const digest = `sha256:${'b'.repeat(64)}`;
const base: BaseEvidence = {
  format: 'kilo-native-base-v1',
  inputSha256: 'c'.repeat(64),
  image: `registry.cloudflare.com/${accountId}/test-native-base@${digest}`,
  sourceSha: 'd'.repeat(40),
  platform: 'linux/amd64',
  abi: RUNTIME_BASE_ABI,
};

it('checks the real managed-registry reference rather than trusting a recorded digest', async () => {
  const api = async (resource: string) => {
    expect(resource).toBe('containers/registries/registry.cloudflare.com/credentials');
    return {
      success: true,
      result: { username: 'v1', password: 'test-temporary-registry-password' },
    };
  };
  const request: typeof fetch = async (input, init) => {
    expect(input).toBe(
      `https://registry.cloudflare.com/v2/${accountId}/test-native-base/manifests/${digest}`
    );
    expect(init?.method).toBe('HEAD');
    return new Response(null, { headers: { 'Docker-Content-Digest': digest } });
  };
  await expect(registryDigest(accountId, base.image, api, request)).resolves.toBe(digest);
  await expect(verifyManagedBase(base, accountId, api, request)).resolves.toBeUndefined();
  await expect(
    verifyManagedBase(base, accountId, api, async () => new Response(null, { status: 404 }))
  ).rejects.toThrow('verification failed (404)');
  await expect(
    verifyManagedBase(
      base,
      accountId,
      api,
      async () =>
        new Response(null, { headers: { 'Docker-Content-Digest': `sha256:${'e'.repeat(64)}` } })
    )
  ).rejects.toThrow('differs from base evidence');
  await expect(
    registryDigest(
      accountId,
      base.image,
      async () => ({ password: 'invalid-unwrapped-response' }),
      request
    )
  ).rejects.toThrow();
});

it('blocks an older deployment after a newer service succeeds, regardless of its wider workflow result', async () => {
  const older = 'a'.repeat(40);
  const newer = 'b'.repeat(40);
  const calls: string[] = [];
  const api = async (resource: string) => {
    calls.push(resource);
    return resource.endsWith('/deployments')
      ? {
          success: true,
          result: {
            deployments: [
              {
                versions: [{ version_id: '023e105f-2a42-4f8b-a1c1-73f6a2a30c0f', percentage: 100 }],
              },
            ],
          },
        }
      : { success: true, result: { annotations: { 'workers/tag': `runtime-ci-${newer}` } } };
  };
  const isAncestor = async (ancestor: string, descendant: string) =>
    ancestor === descendant || (ancestor === older && descendant === newer);
  await expect(
    assertDeployedSourceOrder({ workerName: 'cloud-agent-next', sourceSha: older, api, isAncestor })
  ).rejects.toThrow('stale or divergent');
  await expect(
    assertDeployedSourceOrder({ workerName: 'cloud-agent-next', sourceSha: newer, api, isAncestor })
  ).resolves.toBeUndefined();
  expect(calls.every(call => call.startsWith('workers/scripts/cloud-agent-next/'))).toBe(true);
});

it('keeps the initial untagged baked deployment usable and fails on provider read errors', async () => {
  await expect(
    assertDeployedSourceOrder({
      workerName: 'cloud-agent-next',
      sourceSha: 'a'.repeat(40),
      api: async () => ({ success: true, result: { deployments: [] } }),
      isAncestor: async () => false,
    })
  ).resolves.toBeUndefined();
  await expect(
    assertDeployedSourceOrder({
      workerName: 'cloud-agent-next',
      sourceSha: 'a'.repeat(40),
      api: async () => {
        throw new Error('provider read denied');
      },
      isAncestor: async () => true,
    })
  ).rejects.toThrow('provider read denied');
});
