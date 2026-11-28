import type { MintRequest } from '@kilocode/sts-contracts';
import * as stsSender from '@kilocode/worker-utils/sts-sender';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import { WEB_BYOC_CREDENTIALS_READ, WEB_BYOC_CREDENTIALS_WRITE } from '../web-internal-auth.js';
import { fetchAwsByocConnection } from './aws-credential-resolver.js';
import {
  fetchByocVercelCredential,
  fetchByocVercelEnrollmentForUser,
  projectByocVercelSnapshotMissing,
  projectByocVercelStatus,
} from './vercel-credential-resolver.js';

// The real reader, observed: each call's third argument is the invocation it hands renewals to.
vi.mock('@kilocode/worker-utils/sts-sender', async importOriginal => {
  const actual = await importOriginal<typeof stsSender>();
  return { ...actual, readStsToken: vi.fn(actual.readStsToken) };
});

const MINTED = 'minted.byoc.token';
const identity = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
};
const snapshot = {
  ...identity,
  buildGeneration: '33333333-3333-4333-8333-333333333333',
  runtimeSnapshotId: 'snapshot-1',
};

function mintBinding() {
  return {
    getBundle: vi.fn(),
    mintTokens: vi.fn(async (request: MintRequest) => ({
      status: 'ok' as const,
      tokens: request.tokens.map(({ audience, scope }) => ({
        status: 'issued' as const,
        audience,
        scope,
        token: MINTED,
        jti: `jti-${scope}`,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      })),
    })),
  };
}

function stsEnv() {
  const STS = mintBinding();
  // Only the fields these requests read; the cast stands in for the rest of the Worker env.
  const env = {
    KILOCODE_BACKEND_BASE_URL: 'https://api.kilo.ai',
    BYOC_LOOKUP_SENDER_AUTH: 'sts',
    STS,
  } as unknown as Env;
  return { env, STS };
}

function credential(overrides: Record<string, unknown> = {}) {
  return {
    ...identity,
    // Shape only: these cases never decrypt the token.
    tokenEncrypted: {
      scheme: 'byoc-vercel-credential-rsa-aes-256-gcm',
      version: 1,
      keyId: 'agent-env-vars-v1',
      ciphertext: {
        encryptedData: 'ciphertext',
        encryptedDEK: 'wrapped-key',
        algorithm: 'rsa-aes-256-gcm',
        version: 1,
      },
    },
    tokenScope: 'team',
    teamId: 'team-1',
    projectId: 'project-1',
    teamSlug: 'team-slug',
    projectSlug: 'project-slug',
    setupStatus: 'ready',
    setupStep: null,
    setupError: null,
    buildGeneration: snapshot.buildGeneration,
    runtimeBuildId: 'runtime-build-1',
    runtimeSnapshotId: snapshot.runtimeSnapshotId,
    setupStartedAt: null,
    setupCompletedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(stsSender.readStsToken).mockClear();
});

describe('BYOC requests under BYOC_LOOKUP_SENDER_AUTH=sts', () => {
  it('hands every token read the invocation context', async () => {
    const ctx = { waitUntil: vi.fn() };
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/connections')
        ? Response.json({ ...identity, setupStatus: 'ready', credentialsEncrypted: null })
        : url.includes('/organization/') || url.includes('/user/')
          ? new Response(null, { status: 404 })
          : Response.json(url.includes('?') ? credential() : { updated: true })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { env } = stsEnv();

    await fetchAwsByocConnection(env, identity, identity.credentialId, ctx);
    await fetchByocVercelCredential(env, identity, ctx);
    await expect(fetchByocVercelEnrollmentForUser(env, 'oauth/user', ctx)).rejects.toThrow();
    await projectByocVercelStatus(
      env,
      {
        ...identity,
        buildGeneration: snapshot.buildGeneration,
        setupStatus: 'failed',
        setupStep: null,
        setupError: 'test',
        teamSlug: null,
        projectSlug: null,
        runtimeBuildId: null,
        runtimeSnapshotId: null,
        setupStartedAt: null,
        setupCompletedAt: null,
      },
      ctx
    );

    const reads = vi.mocked(stsSender.readStsToken).mock.calls;
    expect(reads.map(([, token]) => token)).toEqual([
      WEB_BYOC_CREDENTIALS_READ,
      WEB_BYOC_CREDENTIALS_READ,
      WEB_BYOC_CREDENTIALS_READ,
      WEB_BYOC_CREDENTIALS_WRITE,
    ]);
    for (const [, , readCtx] of reads) expect(readCtx).toBe(ctx);
  });

  it('mints the read and write tokens together before the first request', async () => {
    const ctx = { waitUntil: vi.fn() };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? Response.json({ updated: true }) : Response.json(credential())
    );
    vi.stubGlobal('fetch', fetchMock);
    const { env, STS } = stsEnv();

    await expect(projectByocVercelSnapshotMissing(env, snapshot, ctx)).resolves.toBe(true);

    const minted = STS.mintTokens.mock.calls.map(([request]) => request.tokens[0]?.scope);
    expect(minted.sort()).toEqual(
      [WEB_BYOC_CREDENTIALS_READ.scope, WEB_BYOC_CREDENTIALS_WRITE.scope].sort()
    );
    const firstRequest = fetchMock.mock.invocationCallOrder[0] ?? 0;
    for (const order of STS.mintTokens.mock.invocationCallOrder) {
      expect(order).toBeLessThan(firstRequest);
    }
    expect(fetchMock.mock.calls.map(([, init]) => init?.headers)).toEqual([
      { authorization: `Bearer ${MINTED}` },
      { 'content-type': 'application/json', authorization: `Bearer ${MINTED}` },
    ]);
  });

  it('prefetches nothing under legacy', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(credential({ runtimeSnapshotId: 'another-snapshot' }))
    );
    vi.stubGlobal('fetch', fetchMock);
    const { env, STS } = stsEnv();

    await expect(
      projectByocVercelSnapshotMissing(
        {
          ...env,
          BYOC_LOOKUP_SENDER_AUTH: undefined,
          INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
        },
        snapshot
      )
    ).resolves.toBe(false);
    expect(STS.mintTokens).not.toHaveBeenCalled();
  });
});
