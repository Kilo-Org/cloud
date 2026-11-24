import { expect } from '@jest/globals';
import type { ErrorEvent, Event } from '@sentry/nextjs';

const FAKE_KILO_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJraWxvVXNlcklkIjoiZmFrZSJ9.ZmFrZS1raWxvLXNpZ25hdHVyZQ';
const FAKE_VERCEL_JWT =
  'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJzZXJ2ZXJsZXNzIn0.ZmFrZS12ZXJjZWwtc2lnbmF0dXJl';
const FAKE_SESSION_JWE =
  'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..ZmFrZS1pdg.ZmFrZS1zZXNzaW9uLWJvZHk.ZmFrZS10YWc';
const FAKE_PROXY_SIGNATURE = 'fake0proxy0signature0000000000000000000000000000000000000000000';
const FAKE_REWRITE_SIGNATURE = 'fake-rewrite-signature-value';
const FAKE_PROVIDER_KEY = 'sk-or-v1-fake0000000000000000000000';
const FAKE_GITHUB_TOKEN = 'ghs_fake000000000000000000000000';
const FAKE_CLIENT_IP = '192.0.2.44';
const FAKE_JA3 = 'fake-ja3-digest-value';
const FAKE_JA4 = 'fake-ja4-digest-value';
const FAKE_PASSWORD = 'fake-password-value';

export const FAKE_SECRET_VALUES = [
  FAKE_KILO_JWT,
  FAKE_VERCEL_JWT,
  FAKE_SESSION_JWE,
  FAKE_PROXY_SIGNATURE,
  FAKE_REWRITE_SIGNATURE,
  FAKE_PROVIDER_KEY,
  FAKE_GITHUB_TOKEN,
  FAKE_CLIENT_IP,
  FAKE_JA3,
  FAKE_JA4,
  FAKE_PASSWORD,
];

export const KEPT_REQUEST_HEADERS = {
  accept: 'application/json',
  'accept-encoding': 'gzip, br',
  'accept-language': 'en-US',
  'content-type': 'application/json',
  'content-length': '512',
  host: 'app.kilo.sh',
  'user-agent': 'Kilo-Code/5.0.0',
  origin: 'https://app.kilo.sh',
  'x-vercel-id': 'fra1::fra1::abcde-1732451234567-0123456789ab',
  'x-request-id': 'req_fake_0123',
  'x-matched-path': '/api/trpc/[trpc]',
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  'x-forwarded-host': 'app.kilo.sh',
  'x-forwarded-proto': 'https',
};

export const FILTERED_REQUEST_HEADER_NAMES = [
  'authorization',
  'cookie',
  'x-vercel-sc-headers',
  'x-vercel-proxy-signature',
  'x-vercel-proxy-signature-ts',
  'x-vercel-is-internal-rewrite-signature',
  'x-vercel-proxied-for',
  'x-vercel-ja3-digest',
  'x-vercel-ja4-digest',
  'x-vercel-forwarded-for',
  'x-forwarded-for',
  'x-real-ip',
];

export function leakyServerEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: '0f8fad5bd9cb469fa16570867728950e',
    timestamp: 1732451234.567,
    platform: 'node',
    level: 'error',
    environment: 'production',
    server_name: 'fake-host',
    transaction: 'POST /api/trpc/[trpc]',
    message: `sentryLogger: upstream rejected Bearer ${FAKE_KILO_JWT}`,
    exception: {
      values: [
        {
          type: 'Error',
          value: `GitHub request failed for token ${FAKE_GITHUB_TOKEN}`,
          mechanism: { type: 'auto.function.nextjs', handled: false },
          stacktrace: {
            frames: [{ filename: 'app:///route.js', function: 'POST', lineno: 10, colno: 5 }],
          },
        },
      ],
    },
    request: {
      url: 'https://app.kilo.sh/api/trpc/user.getProfile?batch=1',
      method: 'POST',
      query_string: 'batch=1',
      headers: {
        ...KEPT_REQUEST_HEADERS,
        authorization: `Bearer ${FAKE_KILO_JWT}`,
        cookie: `next-auth.session-token=${FAKE_SESSION_JWE}`,
        'x-vercel-sc-headers': JSON.stringify({ Authorization: `Bearer ${FAKE_VERCEL_JWT}` }),
        'x-vercel-proxy-signature': `Bearer ${FAKE_PROXY_SIGNATURE}`,
        'x-vercel-proxy-signature-ts': '1732451234',
        'x-vercel-is-internal-rewrite-signature': FAKE_REWRITE_SIGNATURE,
        'x-vercel-proxied-for': FAKE_CLIENT_IP,
        'x-vercel-ja3-digest': FAKE_JA3,
        'x-vercel-ja4-digest': FAKE_JA4,
        'x-vercel-forwarded-for': FAKE_CLIENT_IP,
        'x-forwarded-for': FAKE_CLIENT_IP,
        'x-real-ip': FAKE_CLIENT_IP,
      },
      cookies: { 'next-auth.session-token': FAKE_SESSION_JWE },
      data: JSON.stringify({ email: 'person@example.com', password: FAKE_PASSWORD }),
    },
    user: { id: 'user-fake-0123' },
    tags: { source: 'openrouter-proxy', 'db.error_code': '57014' },
    extra: {
      args: [
        { authorization: `Bearer ${FAKE_KILO_JWT}`, status: 401 },
        `upstream body: {"api_key":"${FAKE_PROVIDER_KEY}"}`,
      ],
      kiloUserId: 'user-fake-0123',
    },
    contexts: {
      runtime: { name: 'node', version: 'v22.0.0' },
      trace: { trace_id: '0af7651916cd43dd8448eb211c80319c', span_id: 'b7ad6b7169203331' },
      upstream: { password: FAKE_PASSWORD, provider: 'openrouter' },
    },
    breadcrumbs: [
      {
        timestamp: 1732451230,
        category: 'console',
        level: 'log',
        message: `refreshing session ${FAKE_KILO_JWT}`,
        data: { arguments: ['refreshing session', FAKE_KILO_JWT], logger: 'console' },
      },
      {
        timestamp: 1732451231,
        category: 'http',
        type: 'http',
        data: { url: 'https://api.github.com/user', method: 'GET', status_code: 401 },
      },
    ],
    sdk: { name: 'sentry.javascript.nextjs', version: '11.12.0' },
  };
}

export function expectScrubbedServerEvent(result: Event | null | undefined): void {
  expect(result).toBeTruthy();
  const serialized = JSON.stringify(result);
  for (const secret of FAKE_SECRET_VALUES) {
    expect(serialized).not.toContain(secret);
  }

  expect(result?.request?.headers).toEqual({
    ...KEPT_REQUEST_HEADERS,
    ...Object.fromEntries(FILTERED_REQUEST_HEADER_NAMES.map(name => [name, '[Filtered]'])),
  });
  expect(result?.request).not.toHaveProperty('cookies');
  expect(result?.request).not.toHaveProperty('data');
  expect(result?.request?.url).toBe('https://app.kilo.sh/api/trpc/user.getProfile?batch=1');

  expect(result?.message).toBe('sentryLogger: upstream rejected Bearer [Filtered]');
  expect(result?.exception?.values?.[0]?.value).toBe('GitHub request failed for token [Filtered]');
  expect(result?.exception?.values?.[0]?.stacktrace?.frames).toHaveLength(1);
  expect(result?.extra).toEqual({
    args: [{ authorization: '[Filtered]', status: 401 }, 'upstream body: {"api_key":"[Filtered]"}'],
    kiloUserId: 'user-fake-0123',
  });
  expect(result?.contexts).toEqual({
    runtime: { name: 'node', version: 'v22.0.0' },
    trace: { trace_id: '0af7651916cd43dd8448eb211c80319c', span_id: 'b7ad6b7169203331' },
    upstream: { password: '[Filtered]', provider: 'openrouter' },
  });
  expect(result?.tags).toEqual({ source: 'openrouter-proxy', 'db.error_code': '57014' });
  expect(result?.breadcrumbs).toEqual([
    {
      timestamp: 1732451230,
      category: 'console',
      level: 'log',
      message: 'refreshing session [Filtered]',
      data: { arguments: ['refreshing session', '[Filtered]'], logger: 'console' },
    },
    {
      timestamp: 1732451231,
      category: 'http',
      type: 'http',
      data: { url: 'https://api.github.com/user', method: 'GET', status_code: 401 },
    },
  ]);
  expect(result?.user).toEqual({ id: 'user-fake-0123' });
  expect(result?.transaction).toBe('POST /api/trpc/[trpc]');
}
