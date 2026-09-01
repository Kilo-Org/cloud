import { generateKeyPairSync } from 'node:crypto';
import type { VercelComputeCredentialEnvelope } from '@kilocode/db/schema-types';
import {
  decryptSecrets,
  encryptKeyedEnvelope,
  encryptWithPublicKey,
  parseKeyedEnvelope,
} from '@kilocode/encryption';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import {
  ByocCredentialResolverError,
  fetchByocVercelCredential,
  projectByocVercelSnapshotMissing,
  resolveByocVercelCredentials,
  resolveByocVercelRuntimeConfig,
} from './vercel-credential-resolver.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const scheme =
  'byoc-vercel-credential-rsa-aes-256-gcm' satisfies VercelComputeCredentialEnvelope['scheme'];
const keyId = 'agent-env-vars-v1';
const accessToken = 'vercel-secret-token';
const identity = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
};
const snapshot = {
  ...identity,
  buildGeneration: '33333333-3333-4333-8333-333333333333',
  runtimeSnapshotId: 'snapshot-1',
};

const env = {
  KILOCODE_BACKEND_BASE_URL: 'https://backend.example.test',
  AGENT_ENV_VARS_PRIVATE_KEY: keys.privateKey,
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
} as Env;

function encryptCredentialToken(input = identity): VercelComputeCredentialEnvelope {
  return parseKeyedEnvelope(
    encryptKeyedEnvelope(
      accessToken,
      scheme,
      { keyId, publicKeyPem: keys.publicKey },
      `byoc-vercel-credential:v1:${input.organizationId}:${input.credentialId}`
    ),
    scheme
  );
}

function credentialResponse(
  input: {
    organizationId: string;
    credentialId: string;
    tokenEncrypted: unknown;
  },
  overrides: Record<string, unknown> = {}
) {
  return {
    ...input,
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

function stubCredentialResponse(input: {
  organizationId: string;
  credentialId: string;
  tokenEncrypted: unknown;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(credentialResponse(input)))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BYOC Vercel credential encryption', () => {
  it('decrypts a dedicated keyed envelope bound to its organization and credential', async () => {
    stubCredentialResponse({ ...identity, tokenEncrypted: encryptCredentialToken() });

    await expect(resolveByocVercelCredentials(env, identity)).resolves.toEqual({
      accessToken,
      teamId: 'team-1',
    });
  });

  it('prevents the ordinary encryptedSecrets path from decrypting extracted BYOC ciphertext', () => {
    const envelope = encryptCredentialToken();

    expect(() =>
      decryptSecrets({ STOLEN_BYOC_TOKEN: envelope.ciphertext }, keys.privateKey)
    ).toThrow();
  });

  it.each([
    {
      name: 'organization',
      organizationId: '44444444-4444-4444-8444-444444444444',
      credentialId: identity.credentialId,
    },
    {
      name: 'credential',
      organizationId: identity.organizationId,
      credentialId: '55555555-5555-4555-8555-555555555555',
    },
  ])('rejects ciphertext replayed against a different $name', async input => {
    stubCredentialResponse({ ...input, tokenEncrypted: encryptCredentialToken() });

    await expect(resolveByocVercelCredentials(env, input)).rejects.toBeInstanceOf(
      ByocCredentialResolverError
    );
  });

  it.each([
    {
      name: 'ordinary encryptedSecrets envelope',
      envelope: () => encryptWithPublicKey(accessToken, keys.publicKey),
    },
    {
      name: 'foreign envelope scheme',
      envelope: () => ({ ...encryptCredentialToken(), scheme: 'foreign-credential-scheme' }),
    },
    {
      name: 'unknown key identifier',
      envelope: () => ({ ...encryptCredentialToken(), keyId: 'foreign-key-v1' }),
    },
    {
      name: 'malformed ciphertext',
      envelope: () => {
        const encrypted = encryptCredentialToken();
        return {
          ...encrypted,
          ciphertext: { ...encrypted.ciphertext, encryptedData: '' },
        };
      },
    },
  ])('rejects an $name returned by the internal credential API', async ({ envelope }) => {
    stubCredentialResponse({ ...identity, tokenEncrypted: envelope() });

    await expect(fetchByocVercelCredential(env, identity)).rejects.toBeInstanceOf(
      ByocCredentialResolverError
    );
  });

  it('exposes only the generation-fenced snapshot identity after resolving runtime credentials', async () => {
    stubCredentialResponse({ ...identity, tokenEncrypted: encryptCredentialToken() });
    const onSnapshotResolved = vi.fn();

    await expect(
      resolveByocVercelRuntimeConfig(
        {
          ...env,
          VERCEL_SANDBOX_RUNTIME: 'node24',
          VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
          VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
        },
        identity,
        onSnapshotResolved
      )
    ).resolves.toMatchObject({ snapshotId: snapshot.runtimeSnapshotId });

    expect(onSnapshotResolved).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(JSON.stringify(onSnapshotResolved.mock.calls)).not.toContain(accessToken);
  });
});

describe('BYOC Vercel missing snapshot projection', () => {
  it('marks the exact ready generation failed without exposing credentials and normalizes PostgreSQL timestamps', async () => {
    const encrypted = encryptCredentialToken();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Response.json({ updated: true });
      return Response.json(
        credentialResponse(
          { ...identity, tokenEncrypted: encrypted },
          {
            setupStartedAt: '2026-04-29 01:16:12.945+00',
            setupCompletedAt: '2026-04-29 01:20:12.945+00',
          }
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(projectByocVercelSnapshotMissing(env, snapshot)).resolves.toBe(true);

    const update = fetchMock.mock.calls[1]?.[1];
    expect(update?.method).toBe('PATCH');
    expect(typeof update?.body).toBe('string');
    if (typeof update?.body !== 'string') throw new Error('Expected JSON projection');
    expect(JSON.parse(update.body)).toEqual({
      organizationId: identity.organizationId,
      credentialId: identity.credentialId,
      buildGeneration: snapshot.buildGeneration,
      setupStatus: 'failed',
      setupStep: null,
      setupError: 'byoc_vercel_snapshot_missing',
      teamSlug: 'team-slug',
      projectSlug: 'project-slug',
      runtimeBuildId: 'runtime-build-1',
      runtimeSnapshotId: null,
      setupStartedAt: '2026-04-29T01:16:12.945Z',
      setupCompletedAt: null,
    });
    expect(update.body).not.toContain(accessToken);
    expect(update.body).not.toContain(encrypted.ciphertext.encryptedData);
  });

  it.each([
    {
      name: 'newer generation',
      overrides: { buildGeneration: '44444444-4444-4444-8444-444444444444' },
    },
    { name: 'replacement snapshot', overrides: { runtimeSnapshotId: 'snapshot-2' } },
    { name: 'already rebuilding setup', overrides: { setupStatus: 'building' } },
  ])('does not overwrite a $name observed before projection', async ({ overrides }) => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        credentialResponse({ ...identity, tokenEncrypted: encryptCredentialToken() }, overrides)
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(projectByocVercelSnapshotMissing(env, snapshot)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves the original generation fence when setup changes after credential lookup', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? Response.json({ updated: false })
        : Response.json(
            credentialResponse({ ...identity, tokenEncrypted: encryptCredentialToken() })
          )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(projectByocVercelSnapshotMissing(env, snapshot)).resolves.toBe(false);

    const body = fetchMock.mock.calls[1]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected fenced JSON projection');
    expect(JSON.parse(body)).toMatchObject({ buildGeneration: snapshot.buildGeneration });
  });

  it('keeps a temporarily unavailable projection retryable', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? new Response(null, { status: 503 })
        : Response.json(
            credentialResponse({ ...identity, tokenEncrypted: encryptCredentialToken() })
          )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(projectByocVercelSnapshotMissing(env, snapshot)).rejects.toBeInstanceOf(
      ByocCredentialResolverError
    );
  });
});
