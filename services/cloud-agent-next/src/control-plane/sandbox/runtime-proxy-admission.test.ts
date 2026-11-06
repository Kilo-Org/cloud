import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import type { ByocVercelCredential } from '../../byoc/vercel-credential-resolver.js';
import type { ByocVercelSource } from '../../byoc/vercel-provider.js';
import type { Env } from '../../types.js';
import { createVercelJwksCache, type vercelJwksCache } from '../../scm-broker/vercel-jwks.js';
import type { RuntimeCredentialProxyOrigin } from '../../runtime-credential-proxy-origin.js';
import {
  admitExpectedRuntimeProxyOriginBinding,
  admitRuntimeProxyOrigin,
  currentRuntimeProxyControlBinding,
  type RuntimeProxyOriginAdmissionContext,
} from './runtime-proxy-admission.js';

const WORKER_URL = 'https://worker.test';
const SANDBOX_ID = 'workspace_test';
const PHYSICAL_NAME = 'physical-1';
const OWNER_ID = 'user-owner';
const TEAM_ID = 'team_synthetic';
const PROJECT_ID = 'project_synthetic';
const ISSUER = `https://oidc.vercel.com/${TEAM_ID}`;
const AUDIENCE = `${WORKER_URL}/runtime-credential-proxy/vercel/${SANDBOX_ID}`;
const SCM_AUDIENCE = `${WORKER_URL}/scm/vercel/${SANDBOX_ID}`;
const NOW = 1_800_000_000_000;
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222';

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...signing.publicKey.export({ format: 'jwk' }),
  kid: 'current',
  alg: 'RS256',
  use: 'sig',
};

function keys() {
  return createVercelJwksCache({
    fetch: vi.fn(async () => Response.json({ keys: [jwk] })),
    now: () => NOW,
  });
}

function vercelCredential(overrides: Partial<ByocVercelCredential> = {}): ByocVercelCredential {
  return {
    organizationId: ORG_ID,
    credentialId: CREDENTIAL_ID,
    setupStatus: 'ready',
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    teamSlug: 'synthetic-team',
    projectSlug: 'synthetic-project',
    ...overrides,
  } as ByocVercelCredential;
}

function vercelToken(claims: Record<string, unknown> = {}, options?: jwt.SignOptions): string {
  return jwt.sign(
    {
      iss: ISSUER,
      aud: AUDIENCE,
      exp: NOW / 1000 + 600,
      team_id: TEAM_ID,
      project_id: PROJECT_ID,
      sandbox_id: 'sess-physical-1',
      ...claims,
    },
    options?.algorithm === 'HS256' ? 'secret' : signing.privateKey,
    { algorithm: 'RS256', keyid: 'current', ...options }
  );
}

function context(
  overrides: Partial<RuntimeProxyOriginAdmissionContext> = {}
): RuntimeProxyOriginAdmissionContext {
  return {
    ownerId: OWNER_ID,
    logicalSandboxId: SANDBOX_ID,
    provider: 'cloudflare-containers',
    allocation: {
      kind: 'connected',
      allocationId: 'allocation-1',
      providerRef: JSON.stringify({
        sandboxId: SANDBOX_ID,
        containment: true,
        instanceId: 'instance-1',
      }),
      connectionId: 'connection-1',
      wrapperId: 'wrapper-1',
    },
    outboundContainerId: 'container-1',
    physicalName: PHYSICAL_NAME,
    locator: null,
    ...overrides,
  };
}

function orgByoc(): ByocVercelSource {
  return { organizationId: ORG_ID, credentialId: CREDENTIAL_ID };
}

function userByoc(userId = OWNER_ID): ByocVercelSource {
  return { userId, credentialId: CREDENTIAL_ID };
}

function vercelContext(
  overrides: Partial<RuntimeProxyOriginAdmissionContext> = {}
): RuntimeProxyOriginAdmissionContext {
  return context({
    provider: 'vercel',
    allocation: {
      kind: 'connected',
      allocationId: 'allocation-1',
      providerRef: JSON.stringify({
        sandboxName: PHYSICAL_NAME,
        sessionId: 'sess-physical-1',
      }),
      connectionId: 'connection-1',
      wrapperId: 'wrapper-1',
    },
    outboundContainerId: SANDBOX_ID,
    byoc: orgByoc(),
    locator: {
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      snapshotId: 'snapshot-1',
      runtimeBuildId: 'runtime-1',
      runtime: 'node24',
    },
    ...overrides,
  });
}

function nativeOrigin(
  overrides: Partial<Extract<RuntimeCredentialProxyOrigin, { type: 'cloudflare-containers' }>> = {}
): RuntimeCredentialProxyOrigin {
  return {
    type: 'cloudflare-containers',
    containerId: 'container-1',
    allocationRef: JSON.stringify({
      sandboxId: SANDBOX_ID,
      containment: true,
      instanceId: 'instance-1',
    }),
    ...overrides,
  };
}

function vercelOrigin(
  claims: Record<string, unknown> = {},
  options?: jwt.SignOptions
): RuntimeCredentialProxyOrigin {
  return {
    type: 'vercel',
    oidcToken: vercelToken(claims, options),
    logicalSandboxId: SANDBOX_ID,
  };
}

function makeDeps(
  overrides: {
    now?: () => number;
    keys?: typeof vercelJwksCache;
    fetchCredential?: (env: Env, input: ByocVercelSource) => Promise<ByocVercelCredential>;
  } = {}
) {
  return {
    env: { WORKER_URL } as Env,
    now: overrides.now ?? (() => NOW),
    keys: overrides.keys ?? keys(),
    fetchCredential: overrides.fetchCredential ?? vi.fn(async () => vercelCredential()),
  };
}

describe('runtime proxy origin admission', () => {
  it('admits trusted native props only for the active provider ref and allocation', async () => {
    const admitted = await admitRuntimeProxyOrigin({
      origin: nativeOrigin(),
      context: context(),
      ...makeDeps(),
    });
    expect(admitted).toEqual({
      plane: 'control',
      logicalSandboxId: SANDBOX_ID,
      allocationId: 'allocation-1',
      provider: 'cloudflare-containers',
      providerInstanceId: context().allocation.providerRef,
      connectionId: 'connection-1',
      wrapperInstanceId: 'wrapper-1',
    });
    for (const [origin, current] of [
      [nativeOrigin({ containerId: 'other-container' }), context()],
      [nativeOrigin({ allocationRef: 'other-ref' }), context()],
      [nativeOrigin(), context({ provider: 'vercel' })],
      [nativeOrigin(), context({ allocation: { ...context().allocation, kind: 'starting' } })],
      [nativeOrigin(), context({ allocation: { ...context().allocation, providerRef: null } })],
      [nativeOrigin(), context({ outboundContainerId: null })],
    ] as const) {
      expect(await admitRuntimeProxyOrigin({ origin, context: current, ...makeDeps() })).toBeNull();
    }
  });

  it('admits a Vercel sandbox only with the SCM RS256 identity and exact audience', async () => {
    expect(
      await admitRuntimeProxyOrigin({
        origin: vercelOrigin(),
        context: vercelContext(),
        ...makeDeps(),
      })
    ).not.toBeNull();
    expect(
      await admitRuntimeProxyOrigin({
        origin: vercelOrigin(),
        context: vercelContext({ logicalSandboxId: 'workspace_other' }),
        ...makeDeps(),
      })
    ).toBeNull();
    expect(
      await admitRuntimeProxyOrigin({
        origin: { type: 'vercel', oidcToken: vercelToken(), logicalSandboxId: 'workspace_other' },
        context: vercelContext(),
        ...makeDeps(),
      })
    ).toBeNull();
  });

  it('denies a mismatched BYOC owner before any credential lookup', async () => {
    const fetchCredential = vi.fn(async () => vercelCredential());
    for (const current of [
      vercelContext({ ownerId: 'user-other', byoc: userByoc(OWNER_ID) }),
      vercelContext({ ownerId: null, byoc: userByoc(OWNER_ID) }),
      vercelContext({ byoc: undefined }),
    ]) {
      await expect(
        admitRuntimeProxyOrigin({
          origin: vercelOrigin(),
          context: current,
          ...makeDeps({ fetchCredential }),
        })
      ).resolves.toBeNull();
    }
    expect(fetchCredential).not.toHaveBeenCalled();
  });

  it('admits an org-owned BYOC source and a user-owned source matching the owner', async () => {
    for (const byoc of [orgByoc(), userByoc(OWNER_ID)]) {
      await expect(
        admitRuntimeProxyOrigin({
          origin: vercelOrigin(),
          context: vercelContext({ byoc }),
          ...makeDeps(),
        })
      ).resolves.toMatchObject({ provider: 'vercel', logicalSandboxId: SANDBOX_ID });
    }
  });

  it('denies wrong Git audience, sandbox name, and non-RS256 tokens', async () => {
    for (const origin of [
      vercelOrigin({ aud: SCM_AUDIENCE }),
      vercelOrigin({ sandbox_name: 'physical-other' }),
      vercelOrigin({}, { algorithm: 'HS256' }),
    ]) {
      await expect(
        admitRuntimeProxyOrigin({ origin, context: vercelContext(), ...makeDeps() })
      ).resolves.toBeNull();
    }
    await expect(
      admitRuntimeProxyOrigin({
        origin: vercelOrigin(),
        context: vercelContext({
          allocation: {
            ...vercelContext().allocation,
            providerRef: JSON.stringify({
              sandboxName: 'physical-other',
              sessionId: 'sess-physical-1',
            }),
          },
        }),
        ...makeDeps(),
      })
    ).resolves.toBeNull();
  });

  it('denies a token that expires during credential or JWKS lookup', async () => {
    let clock = NOW;
    const expiresDuringCredential = vi.fn(async () => {
      clock = (NOW / 1000 + 601) * 1000;
      return vercelCredential();
    });
    await expect(
      admitRuntimeProxyOrigin({
        origin: vercelOrigin({ exp: NOW / 1000 + 600 }),
        context: vercelContext(),
        ...makeDeps({ now: () => clock, fetchCredential: expiresDuringCredential }),
      })
    ).resolves.toBeNull();

    clock = NOW;
    const advancingKeys = {
      async key() {
        clock = (clock / 1000 + 2) * 1000;
        return signing.publicKey;
      },
    } as unknown as typeof vercelJwksCache;
    await expect(
      admitRuntimeProxyOrigin({
        origin: vercelOrigin({ exp: NOW / 1000 + 1 }),
        context: vercelContext(),
        ...makeDeps({ now: () => clock, keys: advancingKeys }),
      })
    ).resolves.toBeNull();
  });

  it('re-admits only the same reconnect-safe binding after re-reading authoritative state', async () => {
    const current = vercelContext();
    const expected = await admitRuntimeProxyOrigin({
      origin: vercelOrigin(),
      context: current,
      ...makeDeps(),
    });
    if (expected === null) throw new Error('expected admission');
    expect(
      await admitExpectedRuntimeProxyOriginBinding({
        origin: vercelOrigin(),
        expected,
        context: current,
        readContext: async () => current,
        ...makeDeps(),
      })
    ).toBe(true);
    const reconnected = vercelContext();
    reconnected.allocation.connectionId = 'connection-2';
    expect(
      await admitExpectedRuntimeProxyOriginBinding({
        origin: vercelOrigin(),
        expected,
        context: current,
        readContext: async () => reconnected,
        ...makeDeps(),
      })
    ).toBe(true);
  });

  it('denies a second admission when the post-await allocation, wrapper or identity changed', async () => {
    const current = vercelContext();
    const expected = await admitRuntimeProxyOrigin({
      origin: vercelOrigin(),
      context: current,
      ...makeDeps(),
    });
    if (expected === null) throw new Error('expected admission');
    for (const latest of [
      vercelContext({
        allocation: { ...current.allocation, allocationId: 'allocation-2' },
      }),
      vercelContext({
        allocation: { ...current.allocation, wrapperId: 'wrapper-2' },
      }),
      vercelContext({
        allocation: { ...current.allocation, kind: 'stopping' },
      }),
      vercelContext({ ownerId: 'user-other' }),
      vercelContext({ physicalName: 'physical-other' }),
      vercelContext({ outboundContainerId: 'container-other' }),
      vercelContext({ byoc: userByoc('user-other') }),
    ]) {
      await expect(
        admitExpectedRuntimeProxyOriginBinding({
          origin: vercelOrigin(),
          expected,
          context: current,
          readContext: async () => latest,
          ...makeDeps(),
        })
      ).resolves.toBe(false);
    }
  });

  it('still verifies the provider on re-admission instead of trusting the caller expected binding', async () => {
    const current = vercelContext();
    const expected = await admitRuntimeProxyOrigin({
      origin: vercelOrigin(),
      context: current,
      ...makeDeps(),
    });
    if (expected === null) throw new Error('expected admission');
    await expect(
      admitExpectedRuntimeProxyOriginBinding({
        origin: vercelOrigin({ aud: SCM_AUDIENCE }),
        expected,
        context: current,
        readContext: async () => current,
        ...makeDeps(),
      })
    ).resolves.toBe(false);
    const unavailable = vi.fn(async () => {
      throw new Error('byoc unavailable');
    });
    await expect(
      admitExpectedRuntimeProxyOriginBinding({
        origin: vercelOrigin(),
        expected,
        context: current,
        readContext: async () => current,
        ...makeDeps({ fetchCredential: unavailable }),
      })
    ).rejects.toThrow('byoc unavailable');
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it('denies a second admission when the token expires during the post-await re-read', async () => {
    const current = vercelContext();
    let clock = NOW;
    const expected = await admitRuntimeProxyOrigin({
      origin: vercelOrigin({ exp: NOW / 1000 + 10 }),
      context: current,
      ...makeDeps({ now: () => clock }),
    });
    if (expected === null) throw new Error('expected admission');
    await expect(
      admitExpectedRuntimeProxyOriginBinding({
        origin: vercelOrigin({ exp: NOW / 1000 + 10 }),
        expected,
        context: current,
        readContext: async () => {
          clock = (NOW / 1000 + 11) * 1000;
          return current;
        },
        ...makeDeps({ now: () => clock }),
      })
    ).resolves.toBe(false);
    expect(currentRuntimeProxyControlBinding(current)).not.toBeNull();
  });
});
