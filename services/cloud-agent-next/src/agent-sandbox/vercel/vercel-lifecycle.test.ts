import { describe, expect, it, vi } from 'vitest';
import type * as ResolverModule from '../../byoc/vercel-credential-resolver.js';

const mocks = vi.hoisted(() => ({
  resolveByocVercelCredentials: vi.fn(),
}));

vi.mock('../../byoc/vercel-credential-resolver.js', async importOriginal => ({
  ...(await importOriginal<typeof ResolverModule>()),
  resolveByocVercelCredentials: mocks.resolveByocVercelCredentials,
}));

import type { AgentSandboxLifecycleHost } from '../protocol.js';
import type { Env } from '../../types.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import { ByocCredentialMissingError } from '../../byoc/vercel-credential-resolver.js';
import { VERCEL_DELETION_TOMBSTONE_KEY } from './vercel-runtime-state.js';
import { VercelSandboxLifecycle } from './vercel-lifecycle.js';

const binding = {
  kind: 'vercel' as const,
  source: {
    kind: 'byoc' as const,
    organizationId: 'org-1',
    credentialId: 'credential-1',
  },
};

const metadata = {
  metadataSchemaVersion: 2,
  identity: { sessionId: 'agent-1', userId: 'user-1' },
  auth: {},
  workspace: {
    sandboxId: 'ses-abcdef',
    sandboxProvider: 'vercel' as const,
    sandboxProviderBinding: binding,
    providerRuntime: { provider: 'vercel' as const, sessionId: 'session-1' },
  },
  lifecycle: { version: 1, timestamp: 1 },
} satisfies SessionMetadata;

function storage(initial: unknown): DurableObjectStorage {
  const values = new Map<string, unknown>([[VERCEL_DELETION_TOMBSTONE_KEY, initial]]);
  return {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
  } as unknown as DurableObjectStorage;
}

type TestLifecycleHost = AgentSandboxLifecycleHost & {
  eraseDurableObjectState: ReturnType<typeof vi.fn>;
  scheduleAlarmAtOrBefore: ReturnType<typeof vi.fn>;
};

function host(initial: unknown): TestLifecycleHost {
  const scheduleAlarmAtOrBefore = vi.fn().mockResolvedValue(undefined);
  const eraseDurableObjectState = vi.fn().mockResolvedValue(undefined);
  return {
    storage: storage(initial),
    runtimeContext: {} as AgentSandboxLifecycleHost['runtimeContext'],
    getProviderBinding: vi.fn().mockResolvedValue(binding),
    scheduleAlarmAtOrBefore,
    eraseDurableObjectState,
    purgeDeletedSessionPayload: vi.fn().mockResolvedValue(undefined),
    getSessionIdForLogs: vi.fn().mockReturnValue('agent-1'),
  };
}

describe('VercelSandboxLifecycle', () => {
  it('pins a BYOC binding in the deletion tombstone', async () => {
    const lifecycle = new VercelSandboxLifecycle({} as Env, host(undefined));
    const result = await lifecycle.planDeletion({
      metadata,
      intent: { reason: 'explicit', startedAt: 100 },
      now: 100,
    });

    expect(result).toMatchObject({
      kind: 'deferred',
      entries: {
        [VERCEL_DELETION_TOMBSTONE_KEY]: { sandboxProviderBinding: binding },
      },
    });
  });

  it('forgets local deletion state when BYOC authority is removed without platform fallback', async () => {
    mocks.resolveByocVercelCredentials.mockRejectedValueOnce(
      new ByocCredentialMissingError('credential-1')
    );
    const lifecycleHost = host({
      version: 2,
      provider: 'vercel',
      sandboxProviderBinding: binding,
      sandboxName: 'ses-abcdef',
      sessionId: 'session-1',
      intent: { reason: 'explicit', startedAt: 100 },
      stop: { status: 'needed', attempts: 0, nextAttemptAt: 100 },
    });
    const lifecycle = new VercelSandboxLifecycle(
      { VERCEL_TOKEN: 'platform-token', VERCEL_TEAM_ID: 'platform-team' } as Env,
      lifecycleHost
    );

    await expect(lifecycle.reconcilePendingDeletion(100)).resolves.toBe('handled');
    expect(mocks.resolveByocVercelCredentials).toHaveBeenCalledWith(expect.anything(), {
      organizationId: binding.source.organizationId,
      credentialId: binding.source.credentialId,
    });
    expect(lifecycleHost.eraseDurableObjectState).toHaveBeenCalledOnce();
    expect(lifecycleHost.scheduleAlarmAtOrBefore).not.toHaveBeenCalled();
  });
});
