import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AppleJwtClientError, verifyAppleJwtWithJwks } from './apple-jwks';

describe('verifyAppleJwtWithJwks', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('classifies JWT verification failures as client errors', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, kid: 'verification-key', use: 'sig', alg: 'RS256' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const token = jwt.sign({ email: 'user@example.com' }, privateKey, {
      algorithm: 'RS256',
      keyid: 'verification-key',
      issuer: 'https://appleid.apple.com',
      audience: 'wrong-audience',
      expiresIn: '5m',
    });

    await expect(verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp')).rejects.toThrow(
      AppleJwtClientError
    );
  });

  it('preserves JWKS fetch failures as server errors', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const token = jwt.sign({}, privateKey, {
      algorithm: 'RS256',
      keyid: 'unseen-key',
      issuer: 'https://appleid.apple.com',
      audience: 'com.kilocode.kiloapp',
      expiresIn: '5m',
    });

    await expect(verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp')).rejects.toThrow(
      'Failed to fetch Apple JWKS: 503'
    );
  });
});
