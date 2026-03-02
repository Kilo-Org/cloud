import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { verifyKiloToken } from './kilo-token.js';

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

describe('verifyKiloToken', () => {
  it('accepts a valid version-3 token', async () => {
    const token = await sign({ version: 3, kiloUserId: 'user-123' });
    const payload = await verifyKiloToken(token, SECRET);
    expect(payload.kiloUserId).toBe('user-123');
    expect(payload.version).toBe(3);
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
