import { describe, it, expect, vi, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import {
  kiloTokenPayload,
  KILO_TOKEN_VERSION,
  signKiloToken,
  verifyKiloToken,
  type SignKiloTokenExtra,
} from './kilo-token.js';

const SECRET = 'test-secret-at-least-32-characters-long';

function encode(secret: string) {
  return new TextEncoder().encode(secret);
}

async function sign(payload: Record<string, unknown>, secret = SECRET, expiresIn = '1h') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(encode(secret));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('signKiloToken', () => {
  it('round-trips through verifyKiloToken with known extra claims', async () => {
    const { token } = await signKiloToken({
      userId: 'user-123',
      pepper: 'pepper-123',
      secret: SECRET,
      expiresInSeconds: 60,
      env: 'development',
      extra: {
        botId: 'bot-1',
        internalApiUse: true,
        gastownAccess: true,
      },
    });

    const payload = await verifyKiloToken(token, SECRET);

    expect(payload).toMatchObject({
      kiloUserId: 'user-123',
      apiTokenPepper: 'pepper-123',
      version: KILO_TOKEN_VERSION,
      env: 'development',
      botId: 'bot-1',
      internalApiUse: true,
      gastownAccess: true,
    });
  });

  it('rejects runtime extras outside the closed schema', async () => {
    await expect(
      signKiloToken({
        userId: 'user-123',
        pepper: null,
        secret: SECRET,
        expiresInSeconds: 60,
        extra: { unknownClaim: true } as unknown as SignKiloTokenExtra,
      })
    ).rejects.toThrow();
  });

  it('returns an ISO expiresAt derived from expiresInSeconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));

    const { expiresAt } = await signKiloToken({
      userId: 'user-123',
      pepper: null,
      secret: SECRET,
      expiresInSeconds: 90,
    });

    expect(expiresAt).toBe('2026-03-10T12:01:30.000Z');
  });

  it('includes env when provided and omits it when absent', async () => {
    const withEnv = await signKiloToken({
      userId: 'user-with-env',
      pepper: null,
      secret: SECRET,
      expiresInSeconds: 60,
      env: 'production',
    });
    const withoutEnv = await signKiloToken({
      userId: 'user-no-env',
      pepper: null,
      secret: SECRET,
      expiresInSeconds: 60,
    });

    const payloadWithEnv = await verifyKiloToken(withEnv.token, SECRET);
    const payloadWithoutEnv = await verifyKiloToken(withoutEnv.token, SECRET);

    expect(payloadWithEnv.env).toBe('production');
    expect(payloadWithoutEnv.env).toBeUndefined();
  });

  it('produces payloads accepted by the closed schema', async () => {
    const { token } = await signKiloToken({
      userId: 'user-schema',
      pepper: 'pepper-schema',
      secret: SECRET,
      expiresInSeconds: 60,
      extra: {
        organizationId: 'org-1',
        organizationRole: 'owner',
        tokenSource: 'cloud-agent',
      },
    });

    const payload = await verifyKiloToken(token, SECRET);

    expect(kiloTokenPayload.parse(payload)).toEqual(payload);
  });
});

describe('verifyKiloToken', () => {
  it('accepts a valid version-3 token', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-123' });
    const payload = await verifyKiloToken(token, SECRET);
    expect(payload.kiloUserId).toBe('user-123');
    expect(payload.version).toBe(KILO_TOKEN_VERSION);
  });

  it('passthrough preserves extra claims', async () => {
    const token = await sign({
      version: 3,
      kiloUserId: 'user-456',
      apiTokenPepper: 'pepper-abc',
      organizationId: 'org-1',
    });
    const payload = await verifyKiloToken(token, SECRET);
    expect(payload.kiloUserId).toBe('user-456');
    // Extra claims survive the parse
    expect((payload as Record<string, unknown>).apiTokenPepper).toBe('pepper-abc');
    expect((payload as Record<string, unknown>).organizationId).toBe('org-1');
  });

  it('rejects wrong version', async () => {
    const token = await sign({ version: 2, kiloUserId: 'user-123' });
    await expect(verifyKiloToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects token missing kiloUserId', async () => {
    const token = await sign({ version: 3 });
    await expect(verifyKiloToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects empty kiloUserId', async () => {
    const token = await sign({ version: 3, kiloUserId: '' });
    await expect(verifyKiloToken(token, SECRET)).rejects.toThrow();
  });

  it('requires the expected audience when one is specified', async () => {
    const token = await new SignJWT({ version: 3, kiloUserId: 'user-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setAudience('git-token-service:bitbucket-repositories')
      .sign(encode(SECRET));

    await expect(
      verifyKiloToken(token, SECRET, {
        audience: 'git-token-service:bitbucket-repositories',
      })
    ).resolves.toMatchObject({ kiloUserId: 'user-123' });
    await expect(verifyKiloToken(token, SECRET, { audience: 'another-service' })).rejects.toThrow();
    await expect(verifyKiloToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects wrong secret', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-123' });
    await expect(
      verifyKiloToken(token, 'wrong-secret-that-is-at-least-32-chars')
    ).rejects.toThrow();
  });

  it('rejects expired token', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-123' }, SECRET, '0s');
    await expect(verifyKiloToken(token, SECRET)).rejects.toThrow();
  });

  it('rejects a non-JWT string', async () => {
    await expect(verifyKiloToken('not.a.token', SECRET)).rejects.toThrow();
  });
});
