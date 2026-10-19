import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';

// The module under test keeps key-set state at module scope, so every test
// loads a fresh instance instead of sharing cache, cooldown, and in-flight
// refresh state across cases.

describe('verifyAppleJwtWithJwks', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });

  const jwkForKey = (kid: string) => ({ ...publicJwk, kid, use: 'sig', alg: 'RS256' });

  const jwksResponse = (keys: ReturnType<typeof jwkForKey>[]) =>
    new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const signToken = (
    kid: string,
    claims: Record<string, unknown> = {},
    audience = 'com.kilocode.kiloapp'
  ) =>
    jwt.sign(claims, privateKey, {
      algorithm: 'RS256',
      keyid: kid,
      issuer: 'https://appleid.apple.com',
      audience,
      expiresIn: '5m',
    });

  const loadFreshModule = async () => {
    jest.resetModules();
    // Static import would share the module-scope key-set state across tests;
    // a fresh dynamic import gives each case its own cache and cooldown.
    return import('./apple-jwks');
  };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('classifies JWT verification failures as client errors', async () => {
    const { verifyAppleJwtWithJwks, AppleJwtClientError } = await loadFreshModule();
    jest.spyOn(global, 'fetch').mockResolvedValue(jwksResponse([jwkForKey('verification-key')]));
    const token = signToken('verification-key', { email: 'user@example.com' }, 'wrong-audience');

    await expect(verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp')).rejects.toThrow(
      AppleJwtClientError
    );
  });

  it('preserves JWKS fetch failures as server errors', async () => {
    const { verifyAppleJwtWithJwks } = await loadFreshModule();
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    const token = signToken('unseen-key');

    await expect(verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp')).rejects.toThrow(
      'Failed to fetch Apple JWKS: 503'
    );
  });

  it('rejects repeated unknown-kid tokens with a bounded number of key-set fetches', async () => {
    const { verifyAppleJwtWithJwks, AppleJwtClientError } = await loadFreshModule();
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => jwksResponse([jwkForKey('known-key')]));
    const token = signToken('unknown-key');

    await expect(verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp')).rejects.toThrow(
      AppleJwtClientError
    );
    await expect(verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp')).rejects.toThrow(
      AppleJwtClientError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 31_000;
    await expect(verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp')).rejects.toThrow(
      AppleJwtClientError
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent unknown-kid refreshes into a single fetch', async () => {
    const { verifyAppleJwtWithJwks, AppleJwtClientError } = await loadFreshModule();
    let pendingResolve!: (response: Response) => void;
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => new Promise<Response>(resolve => (pendingResolve = resolve)));
    const token = signToken('unknown-key');

    const first = verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp');
    const second = verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pendingResolve(jwksResponse([jwkForKey('known-key')]));
    await expect(first).rejects.toThrow(AppleJwtClientError);
    await expect(second).rejects.toThrow(AppleJwtClientError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('verifies tokens signed by a rotated key after refreshing the key set', async () => {
    const { verifyAppleJwtWithJwks } = await loadFreshModule();
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jwksResponse([jwkForKey('old-key')]))
      .mockResolvedValueOnce(jwksResponse([jwkForKey('new-key')]));

    const oldToken = signToken('old-key', { sub: 'user-1' });
    const payload = await verifyAppleJwtWithJwks(oldToken, 'com.kilocode.kiloapp');
    expect(payload.sub).toBe('user-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 31_000;
    const newToken = signToken('new-key', { sub: 'user-2' });
    const newPayload = await verifyAppleJwtWithJwks(newToken, 'com.kilocode.kiloapp');
    expect(newPayload.sub).toBe('user-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached key set usable when a refresh fails', async () => {
    const { verifyAppleJwtWithJwks, AppleJwtClientError } = await loadFreshModule();
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jwksResponse([jwkForKey('current-key')]))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    const goodToken = signToken('current-key', { sub: 'user-1' });
    await verifyAppleJwtWithJwks(goodToken, 'com.kilocode.kiloapp');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 31_000;
    const unknownToken = signToken('rotated-away-key');
    await expect(verifyAppleJwtWithJwks(unknownToken, 'com.kilocode.kiloapp')).rejects.toThrow(
      'Failed to fetch Apple JWKS: 503'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(verifyAppleJwtWithJwks(unknownToken, 'com.kilocode.kiloapp')).rejects.toThrow(
      AppleJwtClientError
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const payload = await verifyAppleJwtWithJwks(goodToken, 'com.kilocode.kiloapp');
    expect(payload.sub).toBe('user-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
