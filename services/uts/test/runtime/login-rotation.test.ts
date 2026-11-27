import { describe, expect, it } from 'vitest';
import { type Env, readConfig } from '../../src/env';
import { getLoginRotationStub } from '../../src/dos/stubs';
import {
  DEPLOYED_TIMING,
  HYPERDRIVE_CONFIG_IDS,
  rotationSettings,
} from '../../src/rotation/config';
import { loginRotationStep } from '../../src/scheduled';
import { config, env } from './test-env';

/** Any bound Hyperdrive config: the settings only check that the replica binding exists. */
const hyperdrive = env.IDENTITY_STORE;

/** The rotation object namespace, made to throw, proving a step never reached it. */
const untouchable: Env['UTS_LOGIN_ROTATION_DO'] = new Proxy(env.UTS_LOGIN_ROTATION_DO, {
  get() {
    throw new Error('the rotation object was reached');
  },
});

describe('the login rotation switch', () => {
  it('is off by default: the object does nothing and the cron step never calls it', async () => {
    expect(config.loginRotation).toEqual({ status: 'off' });
    expect(await getLoginRotationStub(env, config).run()).toEqual({ status: 'off' });
    await loginRotationStep({ ...env, UTS_LOGIN_ROTATION_DO: untouchable }, config);
  });

  it('reports a misconfigured environment that turned it on without its bindings', () => {
    const on: Env = { ...env, LOGIN_ROTATION: 'on' };
    expect(rotationSettings(on, readConfig(on))).toEqual({
      status: 'misconfigured',
      missing: [
        'IDENTITY_STORE_REPLICA',
        'MANAGER_BASE_URL',
        'UTS_LOCAL_SECRETS',
        'CLOUDFLARE_API_BASE_URL',
      ],
    });
  });

  it('runs development against its stand-ins with the shortened timing', () => {
    const on: Env = {
      ...env,
      LOGIN_ROTATION: 'on',
      LOGIN_ROTATION_PERIOD_SECONDS: '5',
      MANAGER_BASE_URL: 'http://127.0.0.1:9562',
      CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9563',
      UTS_LOCAL_SECRETS: '{}',
      IDENTITY_STORE_REPLICA: hyperdrive,
    };
    const settings = rotationSettings(on, readConfig(on));
    expect(settings).toMatchObject({
      status: 'on',
      timing: { periodMs: 5000, offPeakUtcHours: null },
      cloudflare: {
        baseUrl: 'http://127.0.0.1:9563',
        configIds: HYPERDRIVE_CONFIG_IDS.development,
      },
    });
  });

  it('uses the Cloudflare API, Infisical and the deployed timing in production, and STS for its secrets', () => {
    const production: Env = {
      ...env,
      UTS_ENVIRONMENT: 'production',
      DO_JURISDICTION: 'eu',
      PAT_LOOKUP_CONNECTIONS: '32',
      WEBAUTHN_RP_ID: 'app.kilo.ai',
      WEBAUTHN_ORIGINS: 'https://uts.kiloapps.io',
      LOGIN_ROTATION: 'on',
      IDENTITY_STORE_REPLICA: hyperdrive,
    };
    expect(rotationSettings(production, readConfig(production))).toEqual({
      status: 'misconfigured',
      missing: ['STS'],
    });
    const bound: Env = {
      ...production,
      STS: { getBundle: () => Promise.reject(new Error('unused')) },
    };
    expect(rotationSettings(bound, readConfig(bound))).toMatchObject({
      status: 'on',
      timing: DEPLOYED_TIMING,
      manager: { baseUrl: 'https://eu.infisical.com' },
      cloudflare: {
        baseUrl: 'https://api.cloudflare.com',
        configIds: HYPERDRIVE_CONFIG_IDS.production,
      },
    });
    expect(() =>
      readConfig({ ...production, CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:1' })
    ).toThrow('only development names a Cloudflare API stand-in');
    expect(() => readConfig({ ...production, LOGIN_ROTATION: 'yes' })).toThrow();
  });
});
