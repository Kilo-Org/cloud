import { createHmac } from 'node:crypto';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { createOAuthState, verifyOAuthState, verifyOAuthStateDetailed } from './oauth-state';

jest.mock('@/lib/config.server', () => ({ NEXTAUTH_SECRET: 'synthetic-oauth-signing-secret' }));

function signPayload(payload: string, secret = NEXTAUTH_SECRET): string {
  const encoded = Buffer.from(payload).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

describe('oauth state', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test.each([null, ''])('classifies missing state: %s', state => {
    expect(verifyOAuthStateDetailed(state)).toEqual({ status: 'invalid', reason: 'state_missing' });
    expect(verifyOAuthState(state)).toBeNull();
  });

  test('classifies a malformed envelope', () => {
    expect(verifyOAuthStateDetailed('not-a-signed-state')).toEqual({
      status: 'invalid',
      reason: 'state_malformed',
    });
    expect(verifyOAuthState('not-a-signed-state')).toBeNull();
  });

  test('rejects tampered payloads and signatures', () => {
    const state = createOAuthState('user_synthetic', 'oauth/synthetic');
    const [payload, signature] = state.split('.');
    for (const tampered of [`${payload}A.${signature}`, `${payload}.invalid`]) {
      expect(verifyOAuthStateDetailed(tampered)).toEqual({
        status: 'invalid',
        reason: 'signature_invalid',
      });
      expect(verifyOAuthState(tampered)).toBeNull();
    }
  });

  test('rejects state signed with a different secret', () => {
    const state = signPayload('{}', 'different-synthetic-secret');
    expect(verifyOAuthStateDetailed(state)).toEqual({
      status: 'invalid',
      reason: 'signature_invalid',
    });
    expect(verifyOAuthState(state)).toBeNull();
  });

  test.each([
    'not-json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ owner: 1, uid: 'synthetic', iat: 0, nonce: 'nonce' }),
    JSON.stringify({ owner: 'synthetic', uid: 1, iat: 0, nonce: 'nonce' }),
    JSON.stringify({ owner: 'synthetic', uid: 'synthetic', iat: '0', nonce: 'nonce' }),
    JSON.stringify({ owner: 'synthetic', uid: 'synthetic', iat: 0 }),
    JSON.stringify({ owner: 'synthetic', uid: 'synthetic', iat: 0, nonce: '' }),
    '{"owner":"synthetic","uid":"synthetic","iat":1e309,"nonce":"nonce"}',
  ])('rejects signed malformed payload: %s', payload => {
    const state = signPayload(payload);
    expect(verifyOAuthStateDetailed(state)).toEqual({
      status: 'invalid',
      reason: 'state_malformed',
    });
    expect(verifyOAuthState(state)).toBeNull();
  });

  test('accepts the TTL boundary and rejects state one second later', () => {
    const state = createOAuthState('user_synthetic', 'oauth/synthetic');
    jest.advanceTimersByTime(600_000);
    expect(verifyOAuthStateDetailed(state)).toEqual({
      status: 'valid',
      state: { owner: 'user_synthetic', userId: 'oauth/synthetic' },
    });
    expect(verifyOAuthState(state)).toEqual({ owner: 'user_synthetic', userId: 'oauth/synthetic' });
    jest.advanceTimersByTime(1_000);
    expect(verifyOAuthStateDetailed(state)).toEqual({ status: 'invalid', reason: 'state_expired' });
    expect(verifyOAuthState(state)).toBeNull();
  });

  test('rejects state issued in the future', () => {
    const now = Date.now();
    const state = createOAuthState('user_synthetic', 'oauth/synthetic');
    jest.setSystemTime(now - 1_000);
    expect(verifyOAuthStateDetailed(state)).toEqual({
      status: 'invalid',
      reason: 'state_from_future',
    });
    expect(verifyOAuthState(state)).toBeNull();
  });

  test('keeps ignoring non-string optional return paths', () => {
    const state = signPayload(
      JSON.stringify({
        owner: 'user_synthetic',
        uid: 'oauth/synthetic',
        iat: Date.now() / 1000,
        nonce: 'nonce',
        returnTo: 123,
      })
    );
    expect(verifyOAuthState(state)).toEqual({ owner: 'user_synthetic', userId: 'oauth/synthetic' });
  });

  test('round-trips a validated return path', () => {
    const state = createOAuthState('user_123', 'user_123', '/claw/new?step=linear');

    expect(verifyOAuthState(state)).toEqual(
      expect.objectContaining({
        owner: 'user_123',
        userId: 'user_123',
        returnTo: '/claw/new?step=linear',
      })
    );
  });

  test('drops invalid return paths when creating state', () => {
    const state = createOAuthState('user_123', 'user_123', 'https://evil.example.com/path');

    expect(verifyOAuthState(state)).toEqual(
      expect.objectContaining({
        owner: 'user_123',
        userId: 'user_123',
      })
    );
    expect(verifyOAuthState(state)).not.toHaveProperty('returnTo');
  });
});
