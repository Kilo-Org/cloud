import crypto from 'node:crypto';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { createSignedToken, verifySignedToken, verifySignedTokenDetailed } from './signed-token';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-signed-token-secret',
}));

const NOW = new Date('2026-03-01T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const TTL_SECONDS = 600;

type TestPayload = { subject: string };

function parsePayload(raw: Record<string, unknown>): TestPayload | null {
  return typeof raw.subject === 'string' ? { subject: raw.subject } : null;
}

const options = { ttlSeconds: TTL_SECONDS, parse: parsePayload };

function encode(payload: Record<string, unknown> | string): string {
  return Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString(
    'base64url'
  );
}

function sign(encoded: string, secret = NEXTAUTH_SECRET): string {
  return `${encoded}.${crypto.createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

function decodePayload(token: string): Record<string, unknown> {
  const encoded = token.slice(0, token.indexOf('.'));
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createSignedToken', () => {
  it('stamps the issued-at second and a random nonce on the payload', () => {
    const token = createSignedToken({ subject: 'synthetic' });
    const payload = decodePayload(token);

    expect(payload.subject).toBe('synthetic');
    expect(payload.iat).toBe(NOW_SECONDS);
    expect(typeof payload.nonce).toBe('string');
    expect((payload.nonce as string).length).toBeGreaterThan(0);
  });

  it('gives two tokens for the same payload different nonces', () => {
    const first = decodePayload(createSignedToken({ subject: 'synthetic' }));
    const second = decodePayload(createSignedToken({ subject: 'synthetic' }));

    expect(first.nonce).not.toBe(second.nonce);
  });
});

describe('verifySignedToken', () => {
  it('round-trips the payload it was given', () => {
    const token = createSignedToken({ subject: 'synthetic' });

    expect(verifySignedTokenDetailed(token, options)).toEqual({
      status: 'valid',
      value: { subject: 'synthetic' },
    });
    expect(verifySignedToken(token, options)).toEqual({ subject: 'synthetic' });
  });

  it('accepts a token at the TTL boundary and rejects it one second later', () => {
    const token = createSignedToken({ subject: 'synthetic' });

    jest.setSystemTime(new Date(NOW.getTime() + TTL_SECONDS * 1000));
    expect(verifySignedTokenDetailed(token, options)).toEqual({
      status: 'valid',
      value: { subject: 'synthetic' },
    });

    jest.setSystemTime(new Date(NOW.getTime() + (TTL_SECONDS + 1) * 1000));
    expect(verifySignedTokenDetailed(token, options)).toEqual({
      status: 'invalid',
      reason: 'token_expired',
    });
    expect(verifySignedToken(token, options)).toBeNull();
  });

  it('rejects a token issued in the future', () => {
    const token = sign(
      encode({ subject: 'synthetic', iat: NOW_SECONDS + 1, nonce: 'synthetic-nonce' })
    );

    expect(verifySignedTokenDetailed(token, options)).toEqual({
      status: 'invalid',
      reason: 'token_from_future',
    });
    expect(verifySignedToken(token, options)).toBeNull();
  });

  it('rejects a tampered payload, a tampered signature, and a foreign secret', () => {
    const token = createSignedToken({ subject: 'synthetic' });
    const [encodedPayload, signature] = token.split('.') as [string, string];

    const tamperedPayload = encode({
      subject: 'attacker',
      iat: NOW_SECONDS,
      nonce: 'synthetic-nonce',
    });
    expect(verifySignedTokenDetailed(`${tamperedPayload}.${signature}`, options)).toEqual({
      status: 'invalid',
      reason: 'signature_invalid',
    });

    expect(
      verifySignedTokenDetailed(
        `${encodedPayload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`,
        options
      )
    ).toEqual({ status: 'invalid', reason: 'signature_invalid' });

    expect(
      verifySignedTokenDetailed(sign(encodedPayload, 'different-synthetic-secret'), options)
    ).toEqual({ status: 'invalid', reason: 'signature_invalid' });
  });

  it('classifies a missing or malformed token', () => {
    expect(verifySignedTokenDetailed(null, options)).toEqual({
      status: 'invalid',
      reason: 'token_missing',
    });
    expect(verifySignedTokenDetailed('', options)).toEqual({
      status: 'invalid',
      reason: 'token_missing',
    });
    expect(verifySignedTokenDetailed('not-a-signed-token', options)).toEqual({
      status: 'invalid',
      reason: 'token_malformed',
    });
  });

  it.each([
    ['a payload the parser rejects', { iat: NOW_SECONDS, nonce: 'synthetic-nonce' }],
    ['a missing issued-at second', { subject: 'synthetic', nonce: 'synthetic-nonce' }],
    ['a missing nonce', { subject: 'synthetic', iat: NOW_SECONDS }],
    ['an empty nonce', { subject: 'synthetic', iat: NOW_SECONDS, nonce: '' }],
    ['a payload that is not JSON', 'not-json'],
  ])('classifies %s as payload_invalid', (_label, payload) => {
    const token = sign(encode(payload as Record<string, unknown> | string));

    expect(verifySignedTokenDetailed(token, options)).toEqual({
      status: 'invalid',
      reason: 'payload_invalid',
    });
  });
});
