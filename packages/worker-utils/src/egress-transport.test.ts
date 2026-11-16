import { describe, expect, it } from 'vitest';
import { isAllowedEgressUrl } from './egress-allowlist';
import { buildEgressAuditRequest } from './egress-audit';
import { cleanEgressHeaders } from './egress-http';
import { redactSensitiveHeaders } from './redact-headers';

describe('shared egress transport decisions', () => {
  it.each([
    ['https://example.com/', true],
    ['https://EXAMPLE.com./', true],
    ['https://example.com:443/', true],
    ['http://example.com:80/', true],
    ['https://example.com:8443/', false],
    ['https://other.example/', false],
    ['https://example.com.attacker.test/', false],
    ['https://user@example.com/', false],
    ['https://127.0.0.1/', false],
    ['ftp://example.com/', false],
  ])('checks the exact destination %s', (value, allowed) => {
    expect(isAllowedEgressUrl(new URL(value), ['example.com'])).toBe(allowed);
  });
  it('records the outer CONNECT method without retaining paths or secrets', () => {
    const record = buildEgressAuditRequest({
      requestId: '11111111-1111-4111-8111-111111111111',
      allocationRef: 'allocation-1',
      timestamp: '2026-11-15T00:00:00.000Z',
      method: 'CONNECT',
      scope: 'connection',
      url: new URL('https://EXAMPLE.com/private/path?credential=do-not-retain'),
      decision: 'denied',
    });
    expect(record).toMatchObject({
      method: 'CONNECT',
      scope: 'connection',
      hostname: 'example.com',
      port: 443,
      protocol: 'https:',
      decision: 'denied',
    });
    expect(JSON.stringify(record)).not.toContain('private');
    expect(JSON.stringify(record)).not.toContain('do-not-retain');
  });
});

describe('egress transport headers', () => {
  it('removes transport identity and nominated hop headers while preserving end-to-end headers', () => {
    const headers = new Headers({
      connection: 'X-Private',
      'X-Private': 'remove',
      'proxy-authorization': 'remove',
      'x-kilo-egress-identity': 'remove',
      'x-kilo-egress-credential': 'remove',
      'x-kilo-egress-target': 'remove',
      authorization: 'Bearer managed-alias',
      'content-type': 'application/octet-stream',
    });
    headers.append('set-cookie', 'one=1');
    headers.append('set-cookie', 'two=2');
    const result = cleanEgressHeaders(headers);
    for (const name of [
      'connection',
      'x-private',
      'proxy-authorization',
      'x-kilo-egress-identity',
      'x-kilo-egress-credential',
      'x-kilo-egress-target',
    ])
      expect(result.has(name)).toBe(false);
    expect(result.get('authorization')).toBe('Bearer managed-alias');
    expect(result.getSetCookie()).toEqual(['one=1', 'two=2']);
  });
  it('redacts both proxy authentication fields regardless of case', () => {
    expect(
      redactSensitiveHeaders({
        'X-Kilo-Egress-Identity': 'private',
        'x-kilo-egress-credential': 'private',
      })
    ).toEqual({
      'X-Kilo-Egress-Identity': '[REDACTED]',
      'x-kilo-egress-credential': '[REDACTED]',
    });
  });
});
