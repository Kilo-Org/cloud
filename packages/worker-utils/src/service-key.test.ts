import { hkdfSync } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { deriveServiceKey, type ServiceKeyPurpose } from './service-key.js';

const SECRET = 'test-service-secret';
const PURPOSE = 'web/turnstile-cookie/v1';

describe('deriveServiceKey', () => {
  it('derives the same 32-byte key for the same secret and purpose', async () => {
    const first = await deriveServiceKey(SECRET, PURPOSE);
    const second = await deriveServiceKey(SECRET, PURPOSE);

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
  });

  it('matches HKDF-SHA256 with an empty salt and the purpose as info', async () => {
    const expected = new Uint8Array(hkdfSync('sha256', SECRET, new Uint8Array(), PURPOSE, 32));

    await expect(deriveServiceKey(SECRET, PURPOSE)).resolves.toEqual(expected);
  });

  it('derives different keys for different purposes', async () => {
    const keys = await Promise.all(
      (
        [
          'web/turnstile-cookie/v1',
          'web/turnstile-cookie/v2',
          'web/account-linking-cookie/v1',
          'cloud-agent-next/turnstile-cookie/v1',
        ] satisfies ServiceKeyPurpose[]
      ).map(purpose => deriveServiceKey(SECRET, purpose))
    );

    expect(new Set(keys.map(key => Buffer.from(key).toString('hex'))).size).toBe(keys.length);
  });

  it('derives different keys for different secrets', async () => {
    const key = await deriveServiceKey(SECRET, PURPOSE);
    const otherSecretKey = await deriveServiceKey('other-service-secret', PURPOSE);

    expect(otherSecretKey).not.toEqual(key);
  });

  it('keys an HS256 JWT that only verifies under the same purpose', async () => {
    const key = await deriveServiceKey(SECRET, PURPOSE);
    const token = await new SignJWT({ sub: 'subject' })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(key);

    await expect(jwtVerify(token, key, { algorithms: ['HS256'] })).resolves.toMatchObject({
      payload: { sub: 'subject' },
    });
    await expect(
      jwtVerify(token, await deriveServiceKey(SECRET, 'web/account-linking-cookie/v1'), {
        algorithms: ['HS256'],
      })
    ).rejects.toThrow();
  });

  it('keys an HMAC-SHA256 signature that only verifies under the same purpose', async () => {
    const importHmacKey = async (purpose: ServiceKeyPurpose) =>
      await crypto.subtle.importKey(
        'raw',
        await deriveServiceKey(SECRET, purpose),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
      );
    const message = new TextEncoder().encode('message');
    const signature = await crypto.subtle.sign('HMAC', await importHmacKey(PURPOSE), message);

    await expect(
      crypto.subtle.verify('HMAC', await importHmacKey(PURPOSE), signature, message)
    ).resolves.toBe(true);
    await expect(
      crypto.subtle.verify(
        'HMAC',
        await importHmacKey('web/account-linking-cookie/v1'),
        signature,
        message
      )
    ).resolves.toBe(false);
  });

  it.each(['', '   '])('rejects a blank secret %j', async secret => {
    await expect(deriveServiceKey(secret, PURPOSE)).rejects.toThrow(
      'Service key secret must be configured and non-empty'
    );
  });

  it.each([
    'web/turnstile-cookie/v0',
    'web/turnstile-cookie/v1.5',
    'web/turnstile-cookie/v-1',
    'Web/turnstile-cookie/v1',
    'web/turnstile_cookie/v1',
    'web//v1',
    'web/turnstile/cookie/v1',
    ' web/turnstile-cookie/v1',
  ] as ServiceKeyPurpose[])('rejects malformed purpose %j', async purpose => {
    await expect(deriveServiceKey(SECRET, purpose)).rejects.toThrow('Invalid service key purpose');
  });
});
