import { describe, expect, it } from 'vitest';

import { normalizeBackendUrl } from './backend-url';

describe('backend API root policy', () => {
  it('normalizes HTTPS API roots without changing their prefix', () => {
    expect(normalizeBackendUrl(' https://API.example/v1/// ', false)).toBe(
      'https://api.example/v1'
    );
  });

  it.each([
    'http://localhost:8080/v1',
    'http://model.local/v1',
    'http://127.0.0.1/v1',
    'http://10.1.2.3/v1',
    'http://172.16.0.1/v1',
    'http://172.31.255.255/v1',
    'http://192.168.1.3/v1',
    'http://[::1]/v1',
    'http://[fd12::1]/v1',
    'http://[fc00::1]/v1',
    'http://[fe80::1]/v1',
    'http://[febf::1]/v1',
  ])('requires explicit approval for %s', url => {
    expect(() => normalizeBackendUrl(url, false)).toThrow('httpApprovalRequired');
    expect(normalizeBackendUrl(url, true)).toBe(url);
  });

  it.each([
    'http://example.com/v1',
    'http://8.8.8.8/v1',
    'http://172.15.0.1/v1',
    'http://172.32.0.1/v1',
    'http://192.169.0.1/v1',
    'http://[2001:db8::1]/v1',
    'http://localhost.attacker.com/v1',
    'http://model.local.attacker.com/v1',
  ])('refuses public HTTP even with approval: %s', url => {
    expect(() => normalizeBackendUrl(url, true)).toThrow('publicHttp');
  });

  it.each([
    'https://user:secret@example.com/v1',
    'https://example.com/v1?key=secret',
    'https://example.com/v1?',
    'https://example.com/v1#fragment',
    'https://example.com/v1#',
    'file:///tmp/models',
    'example.com',
    'https://exam\nple.com/v1',
  ])('refuses non-root or credential-bearing input: %s', url => {
    expect(() => normalizeBackendUrl(url, true)).toThrow('invalidUrl');
  });
});
