import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type * as vercelBuilder from './vercel-builder.js';
import { ByocCredentialMissingError } from '../byoc/vercel-credential-resolver.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import type { BuilderLifecycleState, VercelBuilderAllocation } from './builder-provider.js';
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

const MAX_BUILDER_TIMEOUT_MS = 45 * 60_000;
const CREATE_LANDING_MARGIN_MS = DEADLINE_MS.createSettle;

function memoryState(initial: Record<string, unknown> = {}): BuilderLifecycleState {
  let value: unknown = initial;
  return {
    get: async () => value,
    set: async next => {
      value = next;
    },
    clear: async () => {
      value = undefined;
    },
  };
}

function provider(now: () => number = Date.now) {
  return createBuilderProvider({
    containers: {} as never,
    env: {} as Env,
    now,
  });
}

describe('Vercel builder capture credentials', () => {
  it('fails promptly when the pinned credential is gone', async () => {
    openVercelBuilder.mockClear();
    openVercelBuilder.mockRejectedValue(new ByocCredentialMissingError('credential-1'));
    await expect(provider().capture(allocation, 'capture', state)).resolves.toEqual({
      status: 'failed',
      reason: 'snapshot_failed',
    });
  });

  it('fails promptly when the credential no longer matches the pinned target', async () => {
    openVercelBuilder.mockClear();
    openVercelBuilder.mockRejectedValue(new BuilderTargetMismatchError());
    await expect(provider().capture(allocation, 'capture', state)).resolves.toEqual({
      status: 'failed',
      reason: 'snapshot_failed',
    });
  });

  it('retries a transient credential resolver failure', async () => {
    openVercelBuilder.mockClear();
    openVercelBuilder.mockRejectedValue(new BuilderRetryableError('lookup'));
    await expect(provider().capture(allocation, 'capture', state)).rejects.toBeInstanceOf(
      BuilderRetryableError
    );
  });
});

describe('Vercel builder stop without a credential', () => {
  it('finalizes a definite pre-create failure without resolving a credential', async () => {
    openVercelBuilder.mockClear();
    const lifecycle = memoryState();
    await expect(provider().stop(allocation, lifecycle)).resolves.toBe('terminal');
    expect(openVercelBuilder).not.toHaveBeenCalled();
    expect(await lifecycle.get()).toBeUndefined();
  });

  it('bounds an ambiguous create missing its credential by the provider expiry', async () => {
    openVercelBuilder.mockClear();
    openVercelBuilder.mockRejectedValue(new ByocCredentialMissingError('credential-1'));
    const requestedAt = 1_000;
    const expiresAt = requestedAt + MAX_BUILDER_TIMEOUT_MS + CREATE_LANDING_MARGIN_MS;
    const lifecycle = memoryState({ createRequestedAt: requestedAt });

    await expect(provider(() => requestedAt).stop(allocation, lifecycle)).resolves.toBe(
      'retryable'
    );
    expect(await lifecycle.get()).toMatchObject({
      createRequestedAt: requestedAt,
      createExpiresAt: expiresAt,
    });

    await expect(provider(() => expiresAt - 1).stop(allocation, lifecycle)).resolves.toBe(
      'retryable'
    );
    await expect(provider(() => expiresAt).stop(allocation, lifecycle)).resolves.toBe('terminal');
    expect(await lifecycle.get()).toBeUndefined();
  });

  it('bounds an old post-create state with no timing from the moment stop is attempted', async () => {
    openVercelBuilder.mockClear();
    openVercelBuilder.mockRejectedValue(new ByocCredentialMissingError('credential-1'));
    const observedAt = 5_000;
    const expiresAt = observedAt + MAX_BUILDER_TIMEOUT_MS + CREATE_LANDING_MARGIN_MS;
    const lifecycle = memoryState({ sessionId: 'session-1' });

    await expect(provider(() => observedAt).stop(allocation, lifecycle)).resolves.toBe('retryable');
    expect(await lifecycle.get()).toMatchObject({
      sessionId: 'session-1',
      createExpiresAt: expiresAt,
    });
    await expect(provider(() => expiresAt).stop(allocation, lifecycle)).resolves.toBe('terminal');
  });

  it('releases a created sandbox whose credential is gone once its expiry has passed', async () => {
    openVercelBuilder.mockClear();
    openVercelBuilder.mockRejectedValue(new ByocCredentialMissingError('credential-1'));
    const lifecycle = memoryState({
      sessionId: 'session-1',
      createExpiresAt: 2_000,
    });

    await expect(provider(() => 2_000).stop(allocation, lifecycle)).resolves.toBe('terminal');
    expect(await lifecycle.get()).toBeUndefined();
  });
});
