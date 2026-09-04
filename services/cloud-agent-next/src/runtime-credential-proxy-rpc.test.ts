import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import type { SessionMetadata } from './persistence/session-metadata.js';
import {
  issuePersistedRuntimeProxyGrant,
  resolvePersistedRuntimeProxyCredential,
} from './runtime-credential-proxy-rpc.js';
import { RUNTIME_PROXY_GRANT_KEY, type RuntimeProxyGrant } from './runtime-credential-proxy.js';

const secret = 'test-secret';
const env = { NEXTAUTH_SECRET: secret } as never;
const authorizationId = '00000000-0000-4000-8000-000000000001';

type Fence = {
  plane: 'legacy';
  generation: number;
  allocationId: string;
  wrapperRunId: string;
  wrapperConnectionId: string;
};

function authorization(state: 'active' | 'revoked' = 'active'): RuntimeAuthorization {
  const issuedAt = new Date(Date.now());
  return {
    version: 1,
    id: authorizationId,
    resourceKind: 'cloud-agent-next',
    resourceId: 'agent_1',
    userId: 'user_1',
    authorizationUserId: 'user_1',
    organizationId: 'org_1',
    issuedAt: issuedAt.toISOString(),
    delegationExpiresAt: new Date(issuedAt.getTime() + 24 * 60 * 60_000).toISOString(),
    state,
    bindings: { userPepperDigest: 'a'.repeat(64), authorizationPepperDigest: 'b'.repeat(64) },
    source: { admissionSource: 'user' },
  };
}

function metadata(kiloSessionId = 'kilo_1'): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_1', userId: 'user_1', orgId: 'org_1' },
    auth: { kiloSessionId },
    lifecycle: { version: 1, timestamp: 0 },
  };
}

function fence(generation = 1): Fence {
  return {
    plane: 'legacy',
    generation,
    allocationId: 'allocation_1',
    wrapperRunId: 'run_1',
    wrapperConnectionId: 'connection_1',
  };
}

function signedToken(expiresAt: number, nonce?: string): string {
  return jwt.sign({ exp: Math.floor(expiresAt / 1000), ...(nonce ? { nonce } : {}) }, secret, {
    noTimestamp: true,
  });
}

function storage() {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
}

async function issue(input: {
  store: ReturnType<typeof storage>;
  currentMetadata?: SessionMetadata | null;
  currentAuthorization?: RuntimeAuthorization | null;
  currentFence?: Fence | null;
  token?: string | null;
}) {
  return issuePersistedRuntimeProxyGrant({
    env,
    storage: input.store,
    metadata: input.currentMetadata === undefined ? metadata() : input.currentMetadata,
    authorization:
      input.currentAuthorization === undefined ? authorization() : input.currentAuthorization,
    fence: input.currentFence === undefined ? fence() : input.currentFence,
    token: input.token === undefined ? signedToken(Date.now() + 2 * 60 * 60_000) : input.token,
    mode: 'contained',
  });
}

describe('persisted runtime credential proxy RPC', () => {
  it('issues only for active authorization, current session metadata and fence, and a live token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const valid = await issue({ store: storage() });
    expect(valid).toEqual(expect.any(String));

    const expired = signedToken(Date.now() - 1_000);
    for (const input of [
      { currentAuthorization: authorization('revoked') },
      { currentMetadata: null },
      { currentMetadata: metadata('') },
      { currentFence: null },
      { token: expired },
    ]) {
      await expect(issue({ store: storage(), ...input })).resolves.toBeNull();
    }
    vi.useRealTimers();
  });

  it('returns the same stable handle across backing-token renewal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = storage();
    const first = await issue({
      store,
      token: signedToken(Date.now() + 2 * 60 * 60_000, 'backing-token-before-renewal'),
    });
    vi.advanceTimersByTime(60_000);
    const second = await issue({
      store,
      token: signedToken(Date.now() + 4 * 60 * 60_000, 'backing-token-after-renewal'),
    });
    expect(second).toBe(first);
    vi.useRealTimers();
  });

  it('bounds its independent transport lease at one day even with a backing token beyond one hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = storage();
    await issue({ store, token: signedToken(Date.now() + 2 * 60 * 60_000) });

    const grant = await store.get<RuntimeProxyGrant>(RUNTIME_PROXY_GRANT_KEY);
    expect(grant?.leaseExpiresAt).toBe(Date.now() + 24 * 60 * 60_000);
    vi.useRealTimers();
  });

  it('caps a proxy lease to the remaining delegation duration and issues no handle at its deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T23:40:00.000Z'));
    const store = storage();
    const expiringAuthorization = authorization();
    expiringAuthorization.delegationExpiresAt = '2026-01-02T00:00:00.000Z';

    await expect(issue({ store, currentAuthorization: expiringAuthorization })).resolves.toEqual(
      expect.any(String)
    );
    const grant = await store.get<RuntimeProxyGrant>(RUNTIME_PROXY_GRANT_KEY);
    expect(grant?.leaseExpiresAt).toBe(Date.UTC(2026, 0, 2));

    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    await expect(
      issue({ store: storage(), currentAuthorization: expiringAuthorization })
    ).resolves.toBeNull();
    vi.useRealTimers();
  });

  it('resolves a valid handle with its existing backing token', async () => {
    const store = storage();
    const token = signedToken(Date.now() + 10 * 60_000);
    const handle = await issue({ store, token });
    const getToken = vi.fn(async () => token);

    await expect(
      resolvePersistedRuntimeProxyCredential({
        env,
        storage: store,
        handle: handle!,
        metadata: async () => metadata(),
        authorization: async () => authorization(),
        fence: async () => fence(),
        token: getToken,
      })
    ).resolves.toEqual({
      token,
      organizationId: 'org_1',
      runtimeAuthorization: {
        userId: 'user_1',
        authorizationId,
        resourceId: 'agent_1',
      },
    });
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('renews a near-expiry backing token without changing the persisted handle grant lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = storage();
    const nearExpiry = signedToken(Date.now() + 5 * 60_000);
    const renewed = signedToken(Date.now() + 2 * 60 * 60_000);
    const handle = await issue({ store, token: nearExpiry });
    const before = await store.get<RuntimeProxyGrant>(RUNTIME_PROXY_GRANT_KEY);
    const getToken = vi.fn(async () => (getToken.mock.calls.length === 1 ? nearExpiry : renewed));

    await expect(
      resolvePersistedRuntimeProxyCredential({
        env,
        storage: store,
        handle: handle!,
        metadata: async () => metadata(),
        authorization: async () => authorization(),
        fence: async () => fence(),
        token: getToken,
      })
    ).resolves.toMatchObject({ token: renewed });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(await store.get(RUNTIME_PROXY_GRANT_KEY)).toEqual(before);
    vi.useRealTimers();
  });

  it('cannot extend a transport lease through repeated resolve calls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const store = storage();
    const token = signedToken(Date.now() + 2 * 60 * 60_000);
    const handle = await issue({ store, token });
    const original = await store.get<RuntimeProxyGrant>(RUNTIME_PROXY_GRANT_KEY);
    const input = {
      env,
      storage: store,
      handle: handle!,
      metadata: async () => metadata(),
      authorization: async () => authorization(),
      fence: async () => fence(),
      token: async () => token,
    };

    await resolvePersistedRuntimeProxyCredential(input);
    vi.advanceTimersByTime(60 * 60_000);
    await resolvePersistedRuntimeProxyCredential(input);
    expect(await store.get(RUNTIME_PROXY_GRANT_KEY)).toEqual(original);
    vi.useRealTimers();
  });

  it('denies a revoked authorization', async () => {
    const store = storage();
    const token = signedToken(Date.now() + 10 * 60_000);
    const handle = await issue({ store, token });

    await expect(
      resolvePersistedRuntimeProxyCredential({
        env,
        storage: store,
        handle: handle!,
        metadata: async () => metadata(),
        authorization: async () => authorization('revoked'),
        fence: async () => fence(),
        token: async () => token,
      })
    ).resolves.toBeNull();
  });

  it.each(['fence', 'grant'] as const)(
    '%s changes are handled according to the stable grant fence',
    async replacement => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const store = storage();
      const nearExpiry = signedToken(Date.now() + 5 * 60_000);
      const renewed = signedToken(Date.now() + 2 * 60 * 60_000);
      const handle = await issue({ store, token: nearExpiry });
      let currentFence = fence();
      let calls = 0;

      const resolved = await resolvePersistedRuntimeProxyCredential({
        env,
        storage: store,
        handle: handle!,
        metadata: async () => metadata(),
        authorization: async () => authorization(),
        fence: async () => currentFence,
        token: async () => {
          calls += 1;
          if (calls === 2 && replacement === 'fence') currentFence = fence(2);
          if (calls === 2 && replacement === 'grant') {
            await issue({ store, token: renewed });
          }
          return calls === 1 ? nearExpiry : renewed;
        },
      });
      if (replacement === 'fence') {
        expect(resolved).toBeNull();
      } else {
        // Reissuing against the same runtime fence returns the original handle
        // and does not invalidate a request that is concurrently renewing.
        expect(resolved).toMatchObject({ token: renewed });
      }
      vi.useRealTimers();
    }
  );
});
