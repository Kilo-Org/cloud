import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type * as vercelCredentialResolver from '../byoc/vercel-credential-resolver.js';
import {
  ByocCredentialMissingError,
  ByocCredentialResolverError,
} from '../byoc/vercel-credential-resolver.js';
import type { VercelBuilderAllocation } from './builder-provider.js';
import { BuilderRetryableError, BuilderTargetMismatchError } from './builder-errors.js';

const resolveAccessConfig = vi.hoisted(() => vi.fn());
vi.mock('../byoc/vercel-credential-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof vercelCredentialResolver>()),
  resolveByocVercelAccessConfig: resolveAccessConfig,
}));

import { openVercelBuilder } from './vercel-builder.js';

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

beforeEach(() => {
  resolveAccessConfig.mockReset();
  resolveAccessConfig.mockResolvedValue({
    accessToken: 'token',
    teamId: 'team-1',
    projectId: 'project-1',
    scope: 'team',
    snapshotId: 'snap-base',
    runtimeBuildId: 'runtime-1',
    runtime: 'node24',
    initialTimeoutMs: 300_000,
  });
});

describe('openVercelBuilder', () => {
  it('turns a transient credential resolver failure into a retryable builder error', async () => {
    resolveAccessConfig.mockRejectedValue(new ByocCredentialResolverError());
    await expect(openVercelBuilder({} as Env, allocation)).rejects.toBeInstanceOf(
      BuilderRetryableError
    );
  });

  it('keeps a deleted credential definitive', async () => {
    resolveAccessConfig.mockRejectedValue(new ByocCredentialMissingError('credential-1'));
    await expect(openVercelBuilder({} as Env, allocation)).rejects.toBeInstanceOf(
      ByocCredentialMissingError
    );
  });

  it('refuses a credential that no longer matches the pinned account', async () => {
    resolveAccessConfig.mockResolvedValue({
      accessToken: 'token',
      teamId: 'team-2',
      projectId: 'project-1',
      scope: 'team',
      snapshotId: 'snap-base',
      runtimeBuildId: 'runtime-1',
      runtime: 'node24',
      initialTimeoutMs: 300_000,
    });
    await expect(openVercelBuilder({} as Env, allocation)).rejects.toBeInstanceOf(
      BuilderTargetMismatchError
    );
  });
});
