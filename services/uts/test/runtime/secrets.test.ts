import { createExecutionContext } from 'cloudflare:test';
import type { BundleBinding } from '@kilocode/secrets-client';
import type { BundleResult } from '@kilocode/sts-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Env, readConfig } from '../../src/env';
import { handleRequest } from '../../src/http';
import { readUtsSecrets, type UtsSecrets } from '../../src/secrets';
import { mailSettingsFor, signInConfigFor } from '../../src/signin/providers/config';
import { config, env } from './test-env';

/**
 * The runtime secrets (src/secrets.ts): the `worker` source reads only the Worker secrets, the `sts`
 * source only the UTS bundle, and a bundle STS cannot deliver makes the methods that need it answer
 * 503 while every other route keeps working. Synthetic values only; each source holds a different
 * value, so a read that reached the other source cannot pass.
 */

const WORKER_VALUE = 'worker-github-secret-fixture';
const BUNDLE_VALUE = 'bundle-github-secret-fixture';
const DEVICE_KEY = 'D'.repeat(43);

function okBundle(
  secrets: Record<string, string>,
  missing: string[] = [],
  stale = false
): BundleResult {
  return {
    status: 'ok',
    workload: 'uts',
    environment: 'staging',
    // A new version per bundle, so each test sees its own `uts.secrets.read` line.
    etag: `"${crypto.randomUUID().replaceAll('-', '')}"`,
    stale,
    fetchedAt: '2026-11-27T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

const UNAVAILABLE: BundleResult = {
  status: 'unavailable',
  reason: 'manager_unreachable_no_copy',
  retryAfterSeconds: 30,
};

/** A fresh binding per test: the client keeps one bundle per binding for the isolate. */
function stsBinding(...answers: BundleResult[]) {
  let call = 0;
  const getBundle = vi.fn<BundleBinding['getBundle']>(async () => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    return answer;
  });
  return { binding: { getBundle } satisfies BundleBinding, getBundle };
}

const lifetime = () => ({ waitUntil: vi.fn() });

/** The GitHub sign-in turned on by its client id, with a different secret in each source. */
function sourcesEnv(source: 'worker' | 'sts', binding: BundleBinding): Env {
  return {
    ...env,
    SECRETS_SOURCE: source,
    STS: binding,
    SIGNIN_GITHUB_CLIENT_ID: 'github-client-fixture',
    SIGNIN_GITHUB_CLIENT_SECRET: WORKER_VALUE,
    DEVICE_USER_CODE_KEY: DEVICE_KEY,
  };
}

/** Settles `promise` while fake time runs past the client's first-load window. */
async function pastFirstLoad<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(30_000);
  return await promise;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readUtsSecrets', () => {
  it('reads the Worker secrets under the worker source and never calls STS', async () => {
    const sts = stsBinding(okBundle({ SIGNIN_GITHUB_CLIENT_SECRET: BUNDLE_VALUE }));
    const read = await readUtsSecrets(
      sourcesEnv('worker', sts.binding),
      { secretsSource: 'worker' },
      lifetime()
    );
    expect(read).toMatchObject({ status: 'read', source: 'worker' });
    if (read.status !== 'read') return;
    expect(read.values.SIGNIN_GITHUB_CLIENT_SECRET).toBe(WORKER_VALUE);
    expect(sts.getBundle).not.toHaveBeenCalled();
  });

  it('reads secrets-store, the shared rollback value, as the worker source', async () => {
    const sts = stsBinding(okBundle({ SIGNIN_GITHUB_CLIENT_SECRET: BUNDLE_VALUE }));
    const target: Env = { ...sourcesEnv('worker', sts.binding), SECRETS_SOURCE: 'secrets-store' };
    const parsed = readConfig(target);
    expect(parsed.secretsSource).toBe('worker');
    const read = await readUtsSecrets(target, parsed, lifetime());
    expect(read).toMatchObject({
      status: 'read',
      source: 'worker',
      values: { SIGNIN_GITHUB_CLIENT_SECRET: WORKER_VALUE },
    });
    expect(sts.getBundle).not.toHaveBeenCalled();
  });

  it('refuses to start with any other source', () => {
    expect(() => readConfig({ ...env, SECRETS_SOURCE: 'foo' })).toThrow(/SECRETS_SOURCE/);
  });

  it('reads only the bundle under the sts source; a missing or ungranted name is absent', async () => {
    const sts = stsBinding(
      okBundle(
        {
          SIGNIN_GITHUB_CLIENT_SECRET: BUNDLE_VALUE,
          DEVICE_USER_CODE_KEY: DEVICE_KEY,
          SIGNIN_WORKOS_API_KEY: '',
        },
        ['SIGNIN_GOOGLE_CLIENT_SECRET']
      )
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const read = await readUtsSecrets(
      sourcesEnv('sts', sts.binding),
      { secretsSource: 'sts' },
      lifetime()
    );
    expect(read).toMatchObject({ status: 'read', source: 'sts' });
    if (read.status !== 'read') return;
    expect(read.values.SIGNIN_GITHUB_CLIENT_SECRET).toBe(BUNDLE_VALUE);
    expect(read.values).not.toHaveProperty('SIGNIN_GOOGLE_CLIENT_SECRET');
    expect(read.values).not.toHaveProperty('SIGNIN_APPLE_PRIVATE_KEY');
    expect(sts.getBundle).toHaveBeenCalledOnce();
    const lines = log.mock.calls.map(([line]) => String(line));
    const readLine = lines.find(line => line.includes('uts.secrets.read'));
    expect(readLine).toBeDefined();
    const logged: { absent: string[] } = JSON.parse(readLine ?? '{}');
    expect(logged).toMatchObject({ source: 'sts', stale: false, empty: ['SIGNIN_WORKOS_API_KEY'] });
    expect(logged.absent).toContain('SIGNIN_GOOGLE_CLIENT_SECRET');
    expect(logged.absent).not.toContain('SIGNIN_WORKOS_API_KEY');
    expect(readLine).not.toContain(BUNDLE_VALUE);
    expect(readLine).not.toContain(DEVICE_KEY);
  });

  it('answers unavailable when STS has no bundle for a cold isolate', async () => {
    vi.useFakeTimers();
    const sts = stsBinding(UNAVAILABLE);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const read = await pastFirstLoad(
      readUtsSecrets(sourcesEnv('sts', sts.binding), { secretsSource: 'sts' }, lifetime())
    );
    expect(read).toEqual({ status: 'unavailable' });
  });

  it('serves the held copy while STS fails, until it is 24 hours old', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sts = stsBinding(okBundle({ SIGNIN_GITHUB_CLIENT_SECRET: BUNDLE_VALUE }), UNAVAILABLE);
    const target = sourcesEnv('sts', sts.binding);
    const read = () => readUtsSecrets(target, { secretsSource: 'sts' }, lifetime());
    expect(await read()).toMatchObject({ status: 'read' });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const stale = await pastFirstLoad(read());
    expect(stale).toMatchObject({ status: 'read', source: 'sts' });
    if (stale.status === 'read')
      expect(stale.values.SIGNIN_GITHUB_CLIENT_SECRET).toBe(BUNDLE_VALUE);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(await pastFirstLoad(read())).toEqual({ status: 'unavailable' });
  });

  it('keeps reading a copy STS reports stale', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sts = stsBinding(okBundle({ SIGNIN_GITHUB_CLIENT_SECRET: BUNDLE_VALUE }, [], true));
    const read = await readUtsSecrets(
      sourcesEnv('sts', sts.binding),
      { secretsSource: 'sts' },
      lifetime()
    );
    expect(read).toMatchObject({
      status: 'read',
      values: { SIGNIN_GITHUB_CLIENT_SECRET: BUNDLE_VALUE },
    });
  });

  it('reads no values when STS refuses the workload or STS is not bound', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const denied = stsBinding({ status: 'denied', reason: 'unknown_workload' });
    expect(
      await readUtsSecrets(sourcesEnv('sts', denied.binding), { secretsSource: 'sts' }, lifetime())
    ).toEqual({ status: 'read', source: 'sts', values: {} });
    const { STS: _sts, ...unbound } = sourcesEnv('sts', denied.binding);
    expect(await readUtsSecrets(unbound, { secretsSource: 'sts' }, lifetime())).toEqual({
      status: 'read',
      source: 'sts',
      values: {},
    });
    const reasons = errors.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
    expect(reasons).toEqual([
      { event: 'uts.secrets.unavailable', source: 'sts', reason: 'denied' },
      { event: 'uts.secrets.unavailable', source: 'sts', reason: 'not_bound' },
    ]);
  });
});

describe('mail settings for the notice email', () => {
  it('reads no secret where no mail var is set', async () => {
    const read = vi.fn(async (): Promise<UtsSecrets> => ({ status: 'unavailable' }));
    expect(await mailSettingsFor({}, read, config)).toEqual({ status: 'off' });
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the secrets once a mail var is set', async () => {
    const read = vi.fn(async (): Promise<UtsSecrets> => ({ status: 'unavailable' }));
    expect(await mailSettingsFor({ UTS_MAILGUN_DOMAIN: 'mail.example.com' }, read, config)).toEqual(
      { status: 'misconfigured', missing: ['UTS_MAIL_FROM', 'UTS_TURNSTILE_SITE_KEY'] }
    );
    expect(read).toHaveBeenCalledOnce();
  });
});

describe('sign-in provider states from the secrets read', () => {
  const settings = (secrets: UtsSecrets) =>
    signInConfigFor(
      { SIGNIN_GITHUB_CLIENT_ID: 'github-client-fixture', SIGNIN_GOOGLE_CLIENT_ID: 'google' },
      secrets,
      config
    ).providers;

  it('turns a provider on from its bundle secret', () => {
    const github = settings({
      status: 'read',
      source: 'sts',
      values: { SIGNIN_GITHUB_CLIENT_SECRET: BUNDLE_VALUE },
    }).github;
    expect(github).toMatchObject({
      status: 'on',
      credentials: { kind: 'secret', clientSecret: BUNDLE_VALUE },
    });
  });

  it('makes a provider whose secret is absent from the bundle misconfigured, naming it', () => {
    const providers = settings({ status: 'read', source: 'sts', values: {} });
    expect(providers.google).toEqual({
      status: 'misconfigured',
      missing: ['SIGNIN_GOOGLE_CLIENT_SECRET'],
    });
    expect(providers.gitlab).toEqual({ status: 'off' });
  });

  it('makes a provider with its client id set unavailable while STS gives no bundle', () => {
    const providers = settings({ status: 'unavailable' });
    expect(providers.github).toEqual({ status: 'unavailable' });
    expect(providers.gitlab).toEqual({ status: 'off' });
  });
});

describe('the mint Worker under the sts source', () => {
  const fetchMint = (path: string, target: Env, init?: RequestInit) =>
    handleRequest(
      new Request(`${config.endpoints.issuer}${path}`, init),
      target,
      createExecutionContext()
    );

  it('answers a provider start 503 while STS gives no bundle, never using the Worker secret', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sts = stsBinding(UNAVAILABLE);
    const response = await pastFirstLoad(
      fetchMint('/signin/oauth/github/start', sourcesEnv('sts', sts.binding))
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).not.toBeNull();
  });

  it('answers the device grant 503 and leaves it out of uncached metadata while STS gives no bundle', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const target = sourcesEnv('sts', stsBinding(UNAVAILABLE).binding);
    const device = await pastFirstLoad(
      fetchMint('/device_authorization', target, {
        method: 'POST',
        body: new URLSearchParams({ client_id: 'kilo-cli' }),
      })
    );
    expect(device.status).toBe(503);
    expect(await device.json()).toMatchObject({ error: 'temporarily_unavailable' });

    const metadata = await pastFirstLoad(
      fetchMint('/.well-known/oauth-authorization-server', target)
    );
    expect(metadata.headers.get('Cache-Control')).toBe('no-store');
    expect(await metadata.json()).not.toHaveProperty('device_authorization_endpoint');
  });

  it('lists the device grant from the bundle key under the sts source', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sts = stsBinding(okBundle({ DEVICE_USER_CODE_KEY: DEVICE_KEY }));
    const metadata = await fetchMint(
      '/.well-known/oauth-authorization-server',
      sourcesEnv('sts', sts.binding)
    );
    expect(metadata.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(await metadata.json()).toHaveProperty('device_authorization_endpoint');
  });

  it('serves a refresh without reading the secrets', async () => {
    const sts = stsBinding(UNAVAILABLE);
    const response = await fetchMint('/token', sourcesEnv('sts', sts.binding), {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token' }),
    });
    expect(response.status).toBe(400);
    expect(sts.getBundle).not.toHaveBeenCalled();
  });
});
