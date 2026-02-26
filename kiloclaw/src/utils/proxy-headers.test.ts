import { describe, expect, it } from 'vitest';
import { deriveGatewayToken } from '../auth/gateway-token';
import { buildForwardHeaders } from './proxy-headers';

describe('buildForwardHeaders', () => {
  it('adds routing and proxy token headers', async () => {
    const headers = new Headers({
      host: 'example.com',
      'x-request-id': 'req-123',
    });

    const result = await buildForwardHeaders({
      requestHeaders: headers,
      machineId: 'machine-123',
      sandboxId: 'sandbox-abc',
      gatewayTokenSecret: 'secret-123',
    });

    const expectedToken = await deriveGatewayToken('sandbox-abc', 'secret-123');

    expect(result.get('fly-force-instance-id')).toBe('machine-123');
    expect(result.get('x-kiloclaw-proxy-token')).toBe(expectedToken);
    expect(result.get('host')).toBeNull();
    expect(result.get('x-request-id')).toBe('req-123');
  });

  it('overwrites inbound proxy token header', async () => {
    const headers = new Headers({
      'x-kiloclaw-proxy-token': 'old-token',
    });

    const result = await buildForwardHeaders({
      requestHeaders: headers,
      machineId: 'machine-123',
      sandboxId: 'sandbox-abc',
      gatewayTokenSecret: 'secret-123',
    });

    const expectedToken = await deriveGatewayToken('sandbox-abc', 'secret-123');
    expect(result.get('x-kiloclaw-proxy-token')).toBe(expectedToken);
  });
});
