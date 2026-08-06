import { describe, expect, it } from 'vitest';

import { deviceSessionIdFromToken } from '@/lib/auth/device-session-claim';

function base64url(input: string): string {
  return btoa(input).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function makeToken(payload: unknown): string {
  return `${base64url('{"alg":"none"}')}.${base64url(JSON.stringify(payload))}.signature`;
}

describe('deviceSessionIdFromToken', () => {
  it('returns the deviceSessionId claim from a valid token', () => {
    const token = makeToken({ sub: 'user-1', deviceSessionId: 'session-abc' });
    expect(deviceSessionIdFromToken(token)).toBe('session-abc');
  });

  it('returns null when the claim is missing', () => {
    const token = makeToken({ sub: 'user-1' });
    expect(deviceSessionIdFromToken(token)).toBeNull();
  });

  it('returns null for a malformed token without a payload segment', () => {
    expect(deviceSessionIdFromToken('not-a-jwt')).toBeNull();
  });

  it('returns null for an empty payload segment', () => {
    expect(deviceSessionIdFromToken('header..signature')).toBeNull();
  });

  it('returns null when the payload is not valid base64url', () => {
    expect(deviceSessionIdFromToken('header.%%%%.signature')).toBeNull();
  });

  it('returns null when the payload is not valid JSON', () => {
    expect(deviceSessionIdFromToken(`header.${base64url('not json')}.signature`)).toBeNull();
  });

  it('returns null when the payload JSON is not an object', () => {
    expect(deviceSessionIdFromToken(makeToken('plain-string'))).toBeNull();
  });

  it('returns null for an empty deviceSessionId claim', () => {
    const token = makeToken({ sub: 'user-1', deviceSessionId: '' });
    expect(deviceSessionIdFromToken(token)).toBeNull();
  });
});
