import { describe, expect, test } from '@jest/globals';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { generateKiloWebTestKey } from '@kilocode/web-shared/tests/helpers/uts-kilo-web.helper';
import {
  KILO_WEB_CLIENT_KEY_SECRET,
  importKiloWebSigningKey,
  kiloWebSigningKeyProvider,
  signClientAssertion,
} from './kilo-web-key';

class ClientError extends Error {
  constructor(readonly reason: string) {
    super('secret unavailable');
  }
}

describe('importKiloWebSigningKey', () => {
  test('imports the agreed JWK as a non-extractable signing key that signs assertions', async () => {
    const key = await generateKiloWebTestKey();
    const imported = await importKiloWebSigningKey(key.privateJwk);
    if (imported.status !== 'ready') throw new Error('expected ready');
    expect(imported.key.kid).toBe(key.kid);
    expect(imported.key.privateKey.extractable).toBe(false);

    const url = 'http://localhost:8800/account/browser-sessions/read';
    const assertion = await signClientAssertion(imported.key, url);
    const { payload } = await jwtVerify(assertion, key.publicKey, {
      issuer: 'kilo-web',
      subject: 'kilo-web',
      audience: url,
    });
    expect(decodeProtectedHeader(assertion)).toEqual({ alg: 'EdDSA', kid: key.kid });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(60);
    expect(payload.jti).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('refuses a wrong kid, extra members, a mismatched pair and non-JSON', async () => {
    const key = await generateKiloWebTestKey();
    const other = await generateKiloWebTestKey();
    const jwk = JSON.parse(key.privateJwk) as Record<string, string>;
    const otherJwk = JSON.parse(other.privateJwk) as Record<string, string>;
    for (const value of [
      JSON.stringify({ ...jwk, kid: other.kid }),
      JSON.stringify({ ...jwk, extra: 'x' }),
      JSON.stringify({ ...jwk, d: otherJwk.d }),
      'not json',
    ]) {
      expect(await importKiloWebSigningKey(value)).toEqual({ status: 'invalid' });
    }
  });
});

describe('kiloWebSigningKeyProvider', () => {
  test('local development reads its environment unless SECRETS_SOURCE=sts', async () => {
    const key = await generateKiloWebTestKey();
    const neverRead = () => Promise.reject(new Error('the bundle must not be read'));
    const local = kiloWebSigningKeyProvider(
      'development',
      { [KILO_WEB_CLIENT_KEY_SECRET]: key.privateJwk },
      neverRead
    );
    expect((await local()).status).toBe('ready');
    expect(await kiloWebSigningKeyProvider('development', {}, neverRead)()).toEqual({
      status: 'invalid',
    });

    const names: string[] = [];
    const fromSts = kiloWebSigningKeyProvider('development', { SECRETS_SOURCE: 'sts' }, name => {
      names.push(name);
      return Promise.resolve(key.privateJwk);
    });
    expect((await fromSts()).status).toBe('ready');
    expect(names).toEqual(['UTS_KILO_WEB_CLIENT_KEY']);

    // A Vercel runtime never reads the key from its environment, whatever it calls itself.
    const onVercel = kiloWebSigningKeyProvider(
      'development',
      { VERCEL: '1', [KILO_WEB_CLIENT_KEY_SECRET]: key.privateJwk },
      () => Promise.reject(new ClientError('missing'))
    );
    expect(await onVercel()).toEqual({ status: 'invalid' });
  });

  test('deployed environments read only the bundle, never their environment', async () => {
    const key = await generateKiloWebTestKey();
    const runtime = { [KILO_WEB_CLIENT_KEY_SECRET]: key.privateJwk };
    for (const environment of ['production', 'staging'] as const) {
      const provider = kiloWebSigningKeyProvider(environment, runtime, () =>
        Promise.reject(new ClientError('missing'))
      );
      expect(await provider()).toEqual({ status: 'invalid' });
    }
    for (const [reason, status] of [
      ['not_granted', 'invalid'],
      ['denied', 'invalid'],
      ['unavailable', 'unavailable'],
    ] as const) {
      const provider = kiloWebSigningKeyProvider('production', {}, () =>
        Promise.reject(new ClientError(reason))
      );
      expect(await provider()).toEqual({ status });
    }
    const ready = kiloWebSigningKeyProvider('production', {}, () =>
      Promise.resolve(key.privateJwk)
    );
    expect((await ready()).status).toBe('ready');
  });
});
