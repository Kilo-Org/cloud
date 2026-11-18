import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { STALE_CACHE_MAX_AGE_MS } from './apple-jwks';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

// The module under test keeps key-set state at module scope, so every test
// loads a fresh instance instead of sharing cache, cooldown, and in-flight
// refresh state across cases.

describe('verifyAppleJwtWithJwks', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: 'jwk' });

  const jwkForKey = (kid: string) => ({ ...publicJwk, kid, use: 'sig', alg: 'RS256' });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

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
  // The stale-bound tests advance the mocked clock by days; a token signed
  // with expiresIn would be expired long before the case ends, so these
  // carry an explicit 48-hour window from the mocked signing time.
  const signLongLivedToken = (kid: string, nowMs: number, sub = 'user-1') =>
    jwt.sign(
      { sub, iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + 48 * 3600 },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: kid,
        issuer: 'https://appleid.apple.com',
        audience: 'com.kilocode.kiloapp',
      }
    );

  const loadFreshModule = async () => {
    jest.resetModules();
    // Static import would share the module-scope key-set state across tests;
    // a fresh dynamic import gives each case its own cache and cooldown.
    return import('./apple-jwks');
  };

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

  it('refreshes the key set at cache expiry', async () => {
    const { verifyAppleJwtWithJwks } = await loadFreshModule();
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jwksResponse([jwkForKey('current-key')]))
      .mockResolvedValueOnce(jwksResponse([jwkForKey('renewed-key')]));

    await expect(
      verifyAppleJwtWithJwks(signToken('current-key', { sub: 'fixture' }), 'com.kilocode.kiloapp')
    ).resolves.toMatchObject({ sub: 'fixture' });

    now += 60 * 60 * 1000 - 1;
    await expect(
      verifyAppleJwtWithJwks(signToken('current-key', { sub: 'fixture' }), 'com.kilocode.kiloapp')
    ).resolves.toMatchObject({ sub: 'fixture' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(
      verifyAppleJwtWithJwks(signToken('renewed-key', { sub: 'fixture' }), 'com.kilocode.kiloapp')
    ).resolves.toMatchObject({ sub: 'fixture' });
    await expect(
      verifyAppleJwtWithJwks(signToken('current-key'), 'com.kilocode.kiloapp')
    ).rejects.toThrow('No matching Apple public key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the cached key set usable when a refresh fails', async () => {
    const { verifyAppleJwtWithJwks } = await loadFreshModule();
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jwksResponse([jwkForKey('current-key')]))
      .mockResolvedValue(new Response(null, { status: 503 }));

    const goodToken = signToken('current-key', { sub: 'user-1' });
    await verifyAppleJwtWithJwks(goodToken, 'com.kilocode.kiloapp');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 31_000;
    const unknownToken = signToken('rotated-away-key');
    // The first unknown-kid token starts the refresh; its failure falls back
    // to the cached key set, so the failed-refresh fallback propagates the
    // fetch error as a server fault while the held kid still verifies. A
    // propagated failure is reported by the receiving route, not the module.
    await expect(verifyAppleJwtWithJwks(unknownToken, 'com.kilocode.kiloapp')).rejects.toThrow(
      'Failed to fetch Apple JWKS: 503'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      jest.requireMock<{ captureException: jest.Mock }>('@sentry/nextjs').captureException
    ).not.toHaveBeenCalled();

    await expect(verifyAppleJwtWithJwks(unknownToken, 'com.kilocode.kiloapp')).rejects.toThrow(
      'Failed to fetch Apple JWKS: 503'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Within the TTL and the refresh cooldown, the cached key set still
    // verifies tokens whose kid it holds. The propagating throws above
    // already marked this attempt reported, so nothing is reported here.
    const payload = await verifyAppleJwtWithJwks(goodToken, 'com.kilocode.kiloapp');
    expect(payload.sub).toBe('user-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      jest.requireMock<{ captureException: jest.Mock }>('@sentry/nextjs').captureException
    ).not.toHaveBeenCalled();

    // After the cache TTL expires with refreshes still failing, the cached key
    // set keeps verifying the kid it holds while the retry stays bounded.
    // Each new failed attempt is consumed here and reported once.
    now += 60 * 60 * 1000;
    await verifyAppleJwtWithJwks(
      signToken('current-key', { sub: 'user-1' }),
      'com.kilocode.kiloapp'
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      jest.requireMock<{ captureException: jest.Mock }>('@sentry/nextjs').captureException
    ).toHaveBeenCalledTimes(1);
    now += 31_000;
    await verifyAppleJwtWithJwks(
      signToken('current-key', { sub: 'user-1' }),
      'com.kilocode.kiloapp'
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      jest.requireMock<{ captureException: jest.Mock }>('@sentry/nextjs').captureException
    ).toHaveBeenCalledTimes(2);
  });

  it('fails closed once the cached key set is past the stale bound', async () => {
    const { verifyAppleJwtWithJwks } = await loadFreshModule();
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jwksResponse([jwkForKey('current-key')]))
      .mockResolvedValue(new Response(null, { status: 503 }));

    const token = signLongLivedToken('current-key', now);
    await verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A failed refresh inside the stale bound still verifies the held kid.
    now += STALE_CACHE_MAX_AGE_MS;
    await verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Past the bound the cached key set no longer covers a failed refresh:
    // the fetch error propagates and the route reports it.
    now += 31_000;
    await expect(verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp')).rejects.toThrow(
      'Failed to fetch Apple JWKS: 503'
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // An immediate retry lands on the cooldown branch, which fails closed too.
    now += 1_000;
    await expect(verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp')).rejects.toThrow(
      'Failed to fetch Apple JWKS: 503'
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('resets the stale window after a successful refresh', async () => {
    const { verifyAppleJwtWithJwks } = await loadFreshModule();
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jwksResponse([jwkForKey('current-key')]))
      .mockResolvedValue(new Response(null, { status: 503 }));

    const token = signLongLivedToken('current-key', now);
    await verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the bound with refreshes still failing, verification fails closed.
    now += STALE_CACHE_MAX_AGE_MS + 31_000;
    await expect(verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp')).rejects.toThrow(
      'Failed to fetch Apple JWKS: 503'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A successful refresh stores a new fetchedAt and clears the failure.
    now += 31_000;
    fetchMock.mockResolvedValueOnce(jwksResponse([jwkForKey('current-key')]));
    await verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The reset window again covers failed refreshes: the cached set verifies
    // after the cache TTL and another outage, bounded by the cooldown.
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    now += 60 * 60 * 1000;
    await verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    now += 31_000;
    await verifyAppleJwtWithJwks(token, 'com.kilocode.kiloapp');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
