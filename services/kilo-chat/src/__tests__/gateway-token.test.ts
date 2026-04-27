import { describe, it, expect } from 'vitest';
import { deriveGatewayToken } from '../lib/gateway-token';

describe('deriveGatewayToken', () => {
  it('returns a 64-char hex HMAC-SHA256', async () => {
    const token = await deriveGatewayToken('sandbox-1', 'secret');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await deriveGatewayToken('sandbox-1', 'secret');
    const b = await deriveGatewayToken('sandbox-1', 'secret');
    expect(a).toBe(b);
  });

  it('differs for different sandbox IDs', async () => {
    const a = await deriveGatewayToken('sandbox-1', 'secret');
    const b = await deriveGatewayToken('sandbox-2', 'secret');
    expect(a).not.toBe(b);
  });

  it('differs for different secrets', async () => {
    const a = await deriveGatewayToken('sandbox-1', 'secret-a');
    const b = await deriveGatewayToken('sandbox-1', 'secret-b');
    expect(a).not.toBe(b);
  });
});
