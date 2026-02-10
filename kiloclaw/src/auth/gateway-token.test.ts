import { describe, it, expect } from 'vitest';
import { deriveGatewayToken } from './gateway-token';

describe('deriveGatewayToken', () => {
  const SECRET = 'test-gateway-secret';

  it('produces a 64-char hex string (SHA-256)', async () => {
    const token = await deriveGatewayToken('sandbox-abc', SECRET);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic -- same inputs produce same output', async () => {
    const token1 = await deriveGatewayToken('sandbox-abc', SECRET);
    const token2 = await deriveGatewayToken('sandbox-abc', SECRET);
    expect(token1).toBe(token2);
  });

  it('differs for different sandboxIds', async () => {
    const token1 = await deriveGatewayToken('sandbox-abc', SECRET);
    const token2 = await deriveGatewayToken('sandbox-xyz', SECRET);
    expect(token1).not.toBe(token2);
  });

  it('differs for different secrets', async () => {
    const token1 = await deriveGatewayToken('sandbox-abc', 'secret-1');
    const token2 = await deriveGatewayToken('sandbox-abc', 'secret-2');
    expect(token1).not.toBe(token2);
  });
});
