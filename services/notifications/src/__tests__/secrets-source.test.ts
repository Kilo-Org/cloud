import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretUnavailableError, type BundleBinding } from '@kilocode/secrets-client';
import { clearSecretCacheForTest, signKiloToken } from '@kilocode/worker-utils';
import {
  KILO_CHAT_AUDIENCE,
  NOTIFICATIONS_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';

import { authMiddleware, type AuthContext } from '../auth';
import { NotificationsService } from '../index';
import { checkPushReceipts, sendPushNotifications } from '../lib/expo-push';
import type * as ExpoPushModule from '../lib/expo-push';
import { glanceableDeliveryDeps } from '../lib/glanceable-delivery-deps';
import { queue } from '../queue-consumer';
import {
  readNotificationsSecret,
  secretsSource,
  type NotificationsSecretName,
  type NotificationsSecretsEnv,
} from '../secrets';

vi.mock('../lib/expo-push', async importOriginal => ({
  ...(await importOriginal<typeof ExpoPushModule>()),
  sendPushNotifications: vi.fn(),
  checkPushReceipts: vi.fn(),
}));

// Synthetic fixture values only. Each source holds a different value, so a read that reached the
// other source, or fell back to it, cannot pass.
const STORE = {
  NEXTAUTH_SECRET: 'store-nextauth-fixture-0123456789abcdef',
  INTERNAL_API_SECRET: 'store-internal-fixture-0123456789abcdef',
  EXPO_ACCESS_TOKEN: 'store-expo-fixture',
} as const;
const BUNDLE = {
  NEXTAUTH_SECRET: 'bundle-nextauth-fixture-0123456789abcdef',
  INTERNAL_API_SECRET: 'bundle-internal-fixture-0123456789abcdef',
  NOTIFICATIONS_EXPO_ACCESS_TOKEN: 'bundle-expo-fixture',
} as const;
const ETAG = '"0123456789abcdef"';
const USER_ID = 'user-sts-fixture';
const WEB_ORIGIN = 'https://web.fixture.test';

type BundleResult = Awaited<ReturnType<BundleBinding['getBundle']>>;

function okBundle(secrets: Record<string, string>, missing: string[] = []): BundleResult {
  return {
    status: 'ok',
    workload: 'notifications',
    environment: 'production',
    etag: ETAG,
    stale: false,
    fetchedAt: '2026-11-26T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

/** A fresh binding per call: the client keeps one bundle per binding for the isolate. */
function stsBinding(result: BundleResult = okBundle({ ...BUNDLE })) {
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => result);
  return { binding: { getBundle } satisfies BundleBinding, getBundle };
}

function storeSecret(value: string) {
  const get = vi.fn(async () => value);
  return { secret: { get } as SecretsStoreSecret, get };
}

/** Both sources populated, so each test proves which one a read used. */
function bothSources(source: string | undefined, bundle?: BundleResult) {
  const sts = stsBinding(bundle);
  const nextAuth = storeSecret(STORE.NEXTAUTH_SECRET);
  const internal = storeSecret(STORE.INTERNAL_API_SECRET);
  const expo = storeSecret(STORE.EXPO_ACCESS_TOKEN);
  const env = {
    ...(source === undefined ? {} : { SECRETS_SOURCE: source }),
    STS: sts.binding,
    NEXTAUTH_SECRET: nextAuth.secret,
    INTERNAL_API_SECRET: internal.secret,
    EXPO_ACCESS_TOKEN: expo.secret,
  };
  const storeReads = () =>
    nextAuth.get.mock.calls.length + internal.get.mock.calls.length + expo.get.mock.calls.length;
  return { env, sts, nextAuth, internal, expo, storeReads };
}

function lifetime() {
  return { waitUntil: vi.fn() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('secretsSource', () => {
  it('defaults to the Secrets Store', () => {
    expect(secretsSource({})).toBe('secrets-store');
  });

  it.each(['secrets-store', 'sts'] as const)('accepts %s', source => {
    expect(secretsSource({ SECRETS_SOURCE: source })).toBe(source);
  });

  it('fails closed on an unknown source', () => {
    expect(() => secretsSource({ SECRETS_SOURCE: 'infisical' })).toThrow(/SECRETS_SOURCE/);
  });
});

describe('readNotificationsSecret', () => {
  const pairs: Array<[NotificationsSecretName, keyof NotificationsSecretsEnv]> = [
    ['NOTIFICATIONS_APNS_PRIVATE_KEY', 'APNS_PRIVATE_KEY'],
    ['NOTIFICATIONS_EXPO_ACCESS_TOKEN', 'EXPO_ACCESS_TOKEN'],
    ['NEXTAUTH_SECRET', 'NEXTAUTH_SECRET'],
    ['INTERNAL_API_SECRET', 'INTERNAL_API_SECRET'],
  ];

  it.each(pairs)(
    'reads %s from its Secrets Store binding %s by default and from the bundle under sts',
    async (name, binding) => {
      const store = storeSecret(`store-${binding}`);
      const sts = stsBinding(okBundle({ [name]: `bundle-${name}` }));
      const env = { [binding]: store.secret, STS: sts.binding };

      expect(await readNotificationsSecret(env, name, lifetime())).toBe(`store-${binding}`);
      expect(sts.getBundle).not.toHaveBeenCalled();

      const fromBundle = await readNotificationsSecret(
        { ...env, SECRETS_SOURCE: 'sts' },
        name,
        lifetime()
      );
      expect(fromBundle).toBe(`bundle-${name}`);
      expect(store.get).toHaveBeenCalledOnce();
      expect(sts.getBundle).toHaveBeenCalledOnce();

      // Flipping the variable back reads the Secrets Store again.
      expect(
        await readNotificationsSecret({ ...env, SECRETS_SOURCE: 'secrets-store' }, name, lifetime())
      ).toBe(`store-${binding}`);
      expect(store.get).toHaveBeenCalledTimes(2);
      expect(sts.getBundle).toHaveBeenCalledOnce();
    }
  );

  it('refuses a name the bundle does not serve without reading the Secrets Store', async () => {
    const { env, storeReads } = bothSources(
      'sts',
      okBundle({}, ['NOTIFICATIONS_EXPO_ACCESS_TOKEN'])
    );

    const expo = readNotificationsSecret(env, 'NOTIFICATIONS_EXPO_ACCESS_TOKEN', lifetime());
    await expect(expo).rejects.toBeInstanceOf(SecretUnavailableError);
    const nextAuth = readNotificationsSecret(env, 'NEXTAUTH_SECRET', lifetime());
    await expect(nextAuth).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(storeReads()).toBe(0);
  });

  it('refuses every read without the STS binding or on an unknown source', async () => {
    const { env, storeReads } = bothSources('sts');

    const noBinding = { ...env, STS: undefined };
    const unbound = readNotificationsSecret(noBinding, 'INTERNAL_API_SECRET', lifetime());
    await expect(unbound).rejects.toThrow(/STS service binding is missing/);
    const unknown = { ...env, SECRETS_SOURCE: 'infisical' };
    const refused = readNotificationsSecret(unknown, 'INTERNAL_API_SECRET', lifetime());
    await expect(refused).rejects.toThrow(/SECRETS_SOURCE/);
    expect(storeReads()).toBe(0);
  });

  it('serves every read in an isolate from one bundle call', async () => {
    const { env } = bothSources('sts');

    expect(await readNotificationsSecret(env, 'NEXTAUTH_SECRET', lifetime())).toBe(
      BUNDLE.NEXTAUTH_SECRET
    );
    expect(await readNotificationsSecret(env, 'INTERNAL_API_SECRET', lifetime())).toBe(
      BUNDLE.INTERNAL_API_SECRET
    );
    expect(env.STS.getBundle).toHaveBeenCalledOnce();
  });
});

describe('authMiddleware secrets source', () => {
  // The verifier caches the Secrets Store value per isolate; start and leave each test clean so
  // no other suite inherits this file's fixture value.
  beforeEach(() => clearSecretCacheForTest());
  afterEach(() => clearSecretCacheForTest());

  function app() {
    let downstreamCalls = 0;
    const hono = new Hono<{ Bindings: Env; Variables: AuthContext }>();
    hono.use('*', authMiddleware);
    hono.get('/test', c => {
      downstreamCalls++;
      return c.json({ callerId: c.get('callerId') });
    });
    return { hono, downstreamCalls: () => downstreamCalls };
  }

  type BearerOptions = { audience?: string; expiresInSeconds?: number };

  async function bearer(secret: string, options: BearerOptions = {}) {
    const { token } = await signKiloToken({
      userId: USER_ID,
      // The shared test setup's user row holds a null pepper.
      pepper: null,
      secret,
      expiresInSeconds: options.expiresInSeconds ?? 3600,
      env: 'production',
      audience: options.audience ?? NOTIFICATIONS_AUDIENCE,
    });
    return token;
  }

  async function request(env: object, token: string | null) {
    const { hono, downstreamCalls } = app();
    const response = await hono.request(
      '/test',
      token === null ? {} : { headers: { authorization: `Bearer ${token}` } },
      { HYPERDRIVE: { connectionString: 'postgres://unused' }, WORKER_ENV: 'production', ...env },
      createExecutionContext()
    );
    return { status: response.status, body: await response.json(), downstreamCalls };
  }

  it.each([undefined, 'secrets-store'])(
    'accepts a legacy bearer signed with the Secrets Store value (SECRETS_SOURCE=%s)',
    async source => {
      const { env, sts } = bothSources(source);

      const accepted = await request(env, await bearer(STORE.NEXTAUTH_SECRET));
      expect(accepted.status).toBe(200);
      expect(accepted.body).toEqual({ callerId: USER_ID });

      const otherSource = await request(env, await bearer(BUNDLE.NEXTAUTH_SECRET));
      expect(otherSource.status).toBe(401);
      expect(otherSource.body).toEqual({ error: 'Unauthorized' });
      expect(sts.getBundle).not.toHaveBeenCalled();
    }
  );

  it('accepts a bearer signed with the bundle value under sts only', async () => {
    const { env, nextAuth } = bothSources('sts');

    const accepted = await request(env, await bearer(BUNDLE.NEXTAUTH_SECRET));
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ callerId: USER_ID });

    const otherSource = await request(env, await bearer(STORE.NEXTAUTH_SECRET));
    expect(otherSource.status).toBe(401);
    expect(otherSource.body).toEqual({ error: 'Unauthorized' });
    expect(nextAuth.get).not.toHaveBeenCalled();
  });

  it.each(['secrets-store', 'sts'] as const)(
    'keeps 401 for missing, malformed, expired and wrong-audience bearers (%s)',
    async source => {
      const { env } = bothSources(source);
      const secret = source === 'sts' ? BUNDLE.NEXTAUTH_SECRET : STORE.NEXTAUTH_SECRET;
      const tokens = [
        null,
        'not-a-jwt',
        await bearer(secret, { expiresInSeconds: -60 }),
        await bearer(secret, { audience: KILO_CHAT_AUDIENCE }),
      ];
      for (const token of tokens) {
        const result = await request(env, token);
        expect(result.status).toBe(401);
        expect(result.body).toEqual({ error: 'Unauthorized' });
        expect(result.downstreamCalls()).toBe(0);
      }
    }
  );

  it.each([
    ['a bundle that does not grant the name', okBundle({})],
    ['a bundle that reports the name missing', okBundle({}, ['NEXTAUTH_SECRET'])],
    ['an empty bundle value', okBundle({ NEXTAUTH_SECRET: '' })],
    ['a denied bundle', { status: 'denied', reason: 'unknown_workload' } satisfies BundleResult],
  ])('answers 401 under sts for %s without reading the Secrets Store', async (_name, bundle) => {
    const { env, nextAuth } = bothSources('sts', bundle);

    const result = await request(env, await bearer(STORE.NEXTAUTH_SECRET));
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized' });
    expect(nextAuth.get).not.toHaveBeenCalled();
  });

  it('answers 401 for an unknown source without reading either source', async () => {
    const { env, sts, storeReads } = bothSources('infisical');

    const result = await request(env, await bearer(STORE.NEXTAUTH_SECRET));
    expect(result.status).toBe(401);
    expect(storeReads()).toBe(0);
    expect(sts.getBundle).not.toHaveBeenCalled();
  });
});

describe('internal caller secret source', () => {
  // A valid secret with an invalid body answers 400 before any dispatch, so these checks prove the
  // credential decision without sending a notification.
  async function post(env: object, secret: string) {
    const service = new NotificationsService(createExecutionContext(), env as never);
    const response = await service.fetch(
      new Request('https://example.com/internal/v1/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Internal-Secret': secret },
        body: '{}',
      })
    );
    return { status: response.status, body: await response.json() };
  }

  it.each([undefined, 'secrets-store'])(
    'checks the Secrets Store value (SECRETS_SOURCE=%s)',
    async source => {
      const { env, sts } = bothSources(source);

      expect(await post(env, STORE.INTERNAL_API_SECRET)).toEqual({
        status: 400,
        body: { error: 'Invalid body' },
      });
      expect(await post(env, BUNDLE.INTERNAL_API_SECRET)).toEqual({
        status: 401,
        body: { error: 'Unauthorized' },
      });
      expect(sts.getBundle).not.toHaveBeenCalled();
    }
  );

  it('checks the bundle value under sts, never the store value', async () => {
    const { env, internal } = bothSources('sts');

    expect(await post(env, BUNDLE.INTERNAL_API_SECRET)).toEqual({
      status: 400,
      body: { error: 'Invalid body' },
    });
    expect(await post(env, STORE.INTERNAL_API_SECRET)).toEqual({
      status: 401,
      body: { error: 'Unauthorized' },
    });
    expect(internal.get).not.toHaveBeenCalled();
  });

  it('answers 401 under sts for an empty bundle value', async () => {
    const { env, internal } = bothSources('sts', okBundle({ INTERNAL_API_SECRET: '' }));

    expect(await post(env, STORE.INTERNAL_API_SECRET)).toEqual({
      status: 401,
      body: { error: 'Unauthorized' },
    });
    expect(internal.get).not.toHaveBeenCalled();
  });
});

describe('receipt queue secrets source', () => {
  function batch() {
    const ack = vi.fn();
    const retry = vi.fn();
    const body = { ticketTokenPairs: [{ ticketId: 'ticket-1', token: 'device-fixture' }] };
    return { batch: { messages: [{ body, ack, retry }] } as never, ack, retry };
  }

  beforeEach(() => {
    vi.mocked(checkPushReceipts).mockReset();
    vi.mocked(checkPushReceipts).mockResolvedValue({ staleTokens: [], receiptErrors: [] });
  });

  it.each([
    [undefined, STORE.EXPO_ACCESS_TOKEN],
    ['secrets-store', STORE.EXPO_ACCESS_TOKEN],
    ['sts', BUNDLE.NOTIFICATIONS_EXPO_ACCESS_TOKEN],
  ])('checks receipts with the Expo token (SECRETS_SOURCE=%s)', async (source, expected) => {
    const { env, sts, expo } = bothSources(source);
    const message = batch();

    await queue(message.batch, env as never, lifetime());

    expect(message.ack).toHaveBeenCalledOnce();
    expect(vi.mocked(checkPushReceipts).mock.calls[0]?.[1]).toBe(expected);
    expect(expo.get).toHaveBeenCalledTimes(source === 'sts' ? 0 : 1);
    expect(sts.getBundle).toHaveBeenCalledTimes(source === 'sts' ? 1 : 0);
  });

  it('retries the message under sts when the bundle cannot serve the token', async () => {
    const { env, expo } = bothSources('sts', okBundle({}, ['NOTIFICATIONS_EXPO_ACCESS_TOKEN']));
    const message = batch();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await queue(message.batch, env as never, lifetime());

    expect(message.retry).toHaveBeenCalledOnce();
    expect(checkPushReceipts).not.toHaveBeenCalled();
    expect(expo.get).not.toHaveBeenCalled();
  });
});

describe('glanceable delivery secrets source', () => {
  const NOW_SECONDS = 1_790_000_000;

  async function signingKey() {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const der = new Uint8Array(
      (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer
    );
    // `pemToDer` strips the armour and whitespace, so the bare base64 body is a valid key value.
    return { body: btoa(String.fromCharCode(...der)), publicKey: pair.publicKey };
  }

  async function signedBy(jwt: string, publicKey: CryptoKey): Promise<boolean> {
    const [header, claims, signature] = jwt.split('.');
    const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), char =>
      char.charCodeAt(0)
    );
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      bytes,
      new TextEncoder().encode(`${header}.${claims}`)
    );
  }

  async function glanceableEnv(source: string | undefined, bundle?: Record<string, string>) {
    const storeKey = await signingKey();
    const bundleKey = await signingKey();
    const sources = bothSources(
      source,
      okBundle(bundle ?? { ...BUNDLE, NOTIFICATIONS_APNS_PRIVATE_KEY: bundleKey.body })
    );
    const apnsKey = storeSecret(storeKey.body);
    const env = {
      ...sources.env,
      APNS_PRIVATE_KEY: apnsKey.secret,
      APNS_TEAM_ID: 'TEAMFIXTURE',
      APNS_KEY_ID: 'KEYFIXTURE',
      APNS_TOPIC: 'com.example.fixture',
      HYPERDRIVE: { connectionString: 'postgres://unused' },
      KILO_WEB_API_BASE_URL: WEB_ORIGIN,
      // These cases cover the internal secret's source, which only the
      // legacy snapshot credential reads (lib/glanceable-snapshot-auth.ts).
      GLANCEABLE_SNAPSHOT_SENDER_AUTH: 'legacy',
    };
    return { ...sources, env, apnsKey, storeKey, bundleKey };
  }

  /** Records every outbound request; nothing leaves the test. */
  function captureFetch() {
    const requests: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url, headers: new Headers(init.headers) });
      const status = url.startsWith('https://api.push.apple.com/') ? 200 : 503;
      return new Response(null, { status });
    });
    return requests;
  }

  async function sendLiveActivity(env: object) {
    const ctx = createExecutionContext();
    await glanceableDeliveryDeps(env as never, ctx).sendIosLiveActivity(
      [{ token: 'activity-fixture', event: 'update' }],
      { status: 'happy' },
      undefined,
      NOW_SECONDS
    );
    await waitOnExecutionContext(ctx);
  }

  it.each([
    [undefined, 'store'],
    ['secrets-store', 'store'],
    ['sts', 'bundle'],
  ] as const)('signs APNs with the selected key (SECRETS_SOURCE=%s)', async (source, signer) => {
    const fixture = await glanceableEnv(source);
    const requests = captureFetch();

    await sendLiveActivity(fixture.env);

    expect(requests).toHaveLength(1);
    const jwt = requests[0].headers.get('authorization')?.replace(/^bearer /, '') ?? '';
    const expectedKey = signer === 'bundle' ? fixture.bundleKey : fixture.storeKey;
    const otherKey = signer === 'bundle' ? fixture.storeKey : fixture.bundleKey;
    expect(await signedBy(jwt, expectedKey.publicKey)).toBe(true);
    expect(await signedBy(jwt, otherKey.publicKey)).toBe(false);
    expect(fixture.apnsKey.get).toHaveBeenCalledTimes(signer === 'bundle' ? 0 : 1);
  });

  it('skips APNs under sts without the bundle key and never reads the store', async () => {
    const fixture = await glanceableEnv('sts', { ...BUNDLE });
    const requests = captureFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await sendLiveActivity(fixture.env);

    expect(requests).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'APNs Live Activity private key read failed; skipping Live Activity delivery'
    );
    expect(fixture.apnsKey.get).not.toHaveBeenCalled();
  });

  it('keeps the missing-binding skip on the Secrets Store source', async () => {
    const fixture = await glanceableEnv('secrets-store');
    const requests = captureFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await sendLiveActivity({ ...fixture.env, APNS_PRIVATE_KEY: undefined });

    expect(requests).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'APNs Live Activity credentials missing; skipping Live Activity delivery'
    );
  });

  it.each([
    [undefined, STORE.EXPO_ACCESS_TOKEN],
    ['secrets-store', STORE.EXPO_ACCESS_TOKEN],
    ['sts', BUNDLE.NOTIFICATIONS_EXPO_ACCESS_TOKEN],
  ])('sends Expo pushes with the selected token (SECRETS_SOURCE=%s)', async (source, expected) => {
    const fixture = await glanceableEnv(source);
    vi.mocked(sendPushNotifications).mockReset();
    vi.mocked(sendPushNotifications).mockResolvedValue({
      ticketTokenPairs: [],
      staleTokens: [],
      ticketErrors: [],
    });

    await glanceableDeliveryDeps(fixture.env as never, lifetime()).sendExpoPush([
      { to: 'device-fixture', title: 'Fixture' },
    ]);

    expect(vi.mocked(sendPushNotifications).mock.calls[0]?.[1]).toBe(expected);
    expect(fixture.expo.get).toHaveBeenCalledTimes(source === 'sts' ? 0 : 1);
  });

  it.each([
    [undefined, STORE.INTERNAL_API_SECRET],
    ['secrets-store', STORE.INTERNAL_API_SECRET],
    ['sts', BUNDLE.INTERNAL_API_SECRET],
  ])(
    'calls the snapshot route with the selected internal secret (SECRETS_SOURCE=%s)',
    async (source, expected) => {
      const fixture = await glanceableEnv(source);
      const requests = captureFetch();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await glanceableDeliveryDeps(fixture.env as never, lifetime()).buildSnapshot(USER_ID, null);

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(`${WEB_ORIGIN}/api/internal/glanceable-agents-snapshot`);
      expect(requests[0].headers.get('x-internal-secret')).toBe(expected);
      expect(fixture.internal.get).toHaveBeenCalledTimes(source === 'sts' ? 0 : 1);
    }
  );

  it('skips the snapshot under sts when the bundle lacks the internal secret', async () => {
    const fixture = await glanceableEnv('sts', {
      NOTIFICATIONS_EXPO_ACCESS_TOKEN: BUNDLE.NOTIFICATIONS_EXPO_ACCESS_TOKEN,
    });
    const requests = captureFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      await glanceableDeliveryDeps(fixture.env as never, lifetime()).buildSnapshot(USER_ID, null)
    ).toBeNull();
    expect(requests).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'INTERNAL_API_SECRET missing; skipping glanceable aggregate delivery'
    );
    expect(fixture.internal.get).not.toHaveBeenCalled();
  });
});
