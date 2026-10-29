import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type * as vercelBuilder from './vercel-builder.js';
import { ByocCredentialMissingError } from '../byoc/vercel-credential-resolver.js';
import type { VercelBuilderAllocation } from './builder-provider.js';
import { BuilderRetryableError, BuilderTargetMismatchError } from './builder-errors.js';

const openVercelBuilder = vi.hoisted(() => vi.fn());
vi.mock('./vercel-builder.js', async importOriginal => ({
  ...(await importOriginal<typeof vercelBuilder>()),
  openVercelBuilder,
}));

import { createBuilderProvider } from './builder-provider.js';

const allocation: VercelBuilderAllocation = {
  provider: 'vercel',
  sandboxId: 'ses-envbuild-22222222222242228222222222222222',
  allocationId: '33333333-3333-4333-8333-333333333333',
  owner: { type: 'user', id: 'user-1' },
  target: {
    provider: 'vercel',
    credentialId: '44444444-4444-4444-8444-444444444444',
    teamId: 'team-1',
    projectId: 'project-1',
    runtimeBuildId: 'runtime-1',
    baseSnapshotId: 'snap-base',
  },
};
const state = {
  get: async () => null,
  set: async () => undefined,
  clear: async () => undefined,
};

function provider() {
  return createBuilderProvider({
    containers: {} as never,
    env: {} as Env,
  });
}

describe('Vercel builder capture credentials', () => {
  it('fails promptly when the pinned credential is gone', async () => {
    openVercelBuilder.mockRejectedValue(new ByocCredentialMissingError('credential-1'));
    await expect(provider().capture(allocation, 'capture', state)).resolves.toEqual({
      status: 'failed',
      reason: 'snapshot_failed',
    });
  });

  it('fails promptly when the credential no longer matches the pinned target', async () => {
    openVercelBuilder.mockRejectedValue(new BuilderTargetMismatchError());
    await expect(provider().capture(allocation, 'capture', state)).resolves.toEqual({
      status: 'failed',
      reason: 'snapshot_failed',
    });
  });

  it('retries a transient credential resolver failure', async () => {
    openVercelBuilder.mockRejectedValue(new BuilderRetryableError('lookup'));
    await expect(provider().capture(allocation, 'capture', state)).rejects.toBeInstanceOf(
      BuilderRetryableError
    );
  });
});
