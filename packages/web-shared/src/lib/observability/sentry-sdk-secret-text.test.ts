import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import type * as SentryNextjs from '@sentry/nextjs';
import type { Event, NodeOptions } from '@sentry/nextjs';
import {
  addBreadcrumb,
  captureException,
  captureMessage,
  close,
  continueTrace,
  flush,
  getClient,
  startSpan,
  withIsolationScope,
} from '@sentry/nextjs';
import { initServerSentry } from '@kilocode/web-shared/lib/observability/sentry-server';

type Transport = ReturnType<NonNullable<NodeOptions['transport']>>;
type Envelope = Parameters<Transport['send']>[0];

const sentEnvelopes: Envelope[] = [];

// Fake values only. They stay away from the capture calls, because the SDK sends
// nearby source lines as stack frame context.
const FAKE_HOOK_PATH = 'TFAKE0000/BFAKE0000/fakeHookPath0000';
const FAKE_DB_PASSWORD = 'fake-db-password-0000';
const FAKE_QUERY_TOKEN = 'fake-query-token-0000';
const FAKE_KEY_BODY = 'ZmFrZS1wcml2YXRlLWtleQ';
const FAKE_DEVICE_CODE = 'FAKE-DEVICE-0000';
// The webhook hosts are joined at run time, so no literal matches a secret scanner.
const SLACK_HOOK_URL = `${['https://hooks', 'slack.com'].join('.')}/services/${FAKE_HOOK_PATH}`;
const DISCORD_HOOK_URL = `https://discord.com${['/api', 'webhooks'].join('/')}/0000/${FAKE_HOOK_PATH}`;
const DATABASE_URL = `postgres://app_user:${FAKE_DB_PASSWORD}@db.internal:5432/app`;
const TOKEN_URL = `https://api.example.com/v1/items?page=2&access_token=${FAKE_QUERY_TOKEN}`;
const PRIVATE_KEY = [
  ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' '),
  FAKE_KEY_BODY,
  ['-----END', 'PRIVATE', 'KEY-----'].join(' '),
].join('\n');
const DEVICE_POLL_TRANSACTION = `GET /api/device-auth/codes/${FAKE_DEVICE_CODE}`;
const FAKE_INVITE_TOKEN = 'fake-invite-token-0000';
const FAKE_SHARE_TOKEN = 'fake-share-token-0000';
const INVITE_URL = `https://app.kilo.sh/users/accept-invite/${FAKE_INVITE_TOKEN}`;
const SHARE_REFERER = `https://app.kilo.sh/s/${FAKE_SHARE_TOKEN}?sessionId=ses_fake0000`;
// A `sentry-trace` header that asks the server to sample the request.
const SAMPLED_TRACE_HEADER = `${'a'.repeat(32)}-${'b'.repeat(16)}-1`;
const ONE_TIME_CODE = '864201';
const FAKE_VALUES = [
  FAKE_HOOK_PATH,
  FAKE_DB_PASSWORD,
  FAKE_QUERY_TOKEN,
  FAKE_KEY_BODY,
  FAKE_DEVICE_CODE,
];
// Each credential header and cookie name seen in past events, with a fake value.
const CREDENTIAL_HEADER_NAMES = [
  'Authorization',
  'X-Api-Key',
  'X-Internal-Secret',
  'X-Internal-Api-Key',
  'X-Callback-Token',
  'X-Bot-Callback-Token',
  'X-Gitlab-Token',
  'X-Vercel-Oidc-Token',
  'X-Vercel-Sc-Headers',
  'X-Kilo-Runtime-Proxy-Attestation',
];
const CREDENTIAL_COOKIE_NAMES = [
  '__Secure-next-auth.session-token',
  '_vercel_jwt',
  'turnstile_jwt',
];
const fakeCredential = (name: string) => `fake-credential-${name.toLowerCase()}`;

function memoryTransport(): Transport {
  return {
    send: async envelope => {
      sentEnvelopes.push(envelope);
      return {};
    },
    flush: async () => true,
  };
}

// The real SDK runs with the options initServerSentry registers; only the
// network transport is replaced so the test reads the envelopes it would send.
jest.mock('@sentry/nextjs', () => {
  const actual = jest.requireActual<typeof SentryNextjs>('@sentry/nextjs');
  return {
    ...actual,
    init: (options: NodeOptions) => actual.init({ ...options, transport: memoryTransport }),
  };
});

async function sentEvents(): Promise<Event[]> {
  await flush(2000);
  return sentEnvelopes.flatMap(([, items]) =>
    items.filter(([header]) => header.type === 'event').map(([, payload]) => payload as Event)
  );
}

function expectNoFakeValue(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const fake of FAKE_VALUES) {
    expect(serialized).not.toContain(fake);
  }
}

let silencedConsole: jest.SpiedFunction<typeof console.warn>[];

beforeAll(() => {
  silencedConsole = (['log', 'warn', 'error'] as const).map(level =>
    jest.spyOn(console, level).mockImplementation(() => undefined)
  );
  process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://fakepublickey@o0.ingest.example.invalid/0';
  initServerSentry();
});

afterAll(async () => {
  await close(2000);
  for (const spy of silencedConsole) spy.mockRestore();
});

beforeEach(() => {
  sentEnvelopes.length = 0;
});

describe('initServerSentry keeps credentials in free text out of the envelope', () => {
  test('filters webhook URLs, URL userinfo and query tokens in an exception message', async () => {
    withIsolationScope(() => {
      captureException(
        new Error(`notify ${SLACK_HOOK_URL} after ${DATABASE_URL} and ${TOKEN_URL}`)
      );
    });

    const [event] = await sentEvents();

    expect(event?.exception?.values?.at(-1)?.value).toBe(
      'notify https://hooks.slack.com/[Filtered] after postgres://[Filtered]@db.internal:5432/app and https://api.example.com/v1/items?page=2&access_token=[Filtered]'
    );
    expectNoFakeValue(event);
  });

  test('filters the same values in extras, contexts and breadcrumbs', async () => {
    withIsolationScope(scope => {
      scope.setContext('upstream', { endpoint: DISCORD_HOOK_URL, database: DATABASE_URL });
      addBreadcrumb({
        category: 'outbound',
        message: `sent to ${SLACK_HOOK_URL}`,
        data: { url: TOKEN_URL },
      });
      captureException(new Error('upstream call failed'), {
        extra: { requestUrl: TOKEN_URL, pem: PRIVATE_KEY },
      });
    });

    const [event] = await sentEvents();

    expect(event?.extra).toEqual({
      requestUrl: 'https://api.example.com/v1/items?page=2&access_token=[Filtered]',
      pem: '[Filtered]',
    });
    expect(event?.contexts?.upstream).toEqual({
      endpoint: 'https://discord.com/api/webhooks/[Filtered]',
      database: 'postgres://[Filtered]@db.internal:5432/app',
    });
    expectNoFakeValue(event);
  });

  test('filters a device-auth user code in the transaction name', async () => {
    withIsolationScope(scope => {
      scope.setTransactionName(DEVICE_POLL_TRANSACTION);
      captureException(new Error('poll failed'));
    });

    const [event] = await sentEvents();

    expect(event?.transaction).toBe('GET /api/device-auth/codes/:code');
    expectNoFakeValue(event);
  });

  test('keeps every credential header and cookie value out of the request', async () => {
    const cookies = Object.fromEntries(
      CREDENTIAL_COOKIE_NAMES.map(name => [name, fakeCredential(name)])
    );
    withIsolationScope(scope => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          url: 'https://app.kilo.sh/api/openrouter/chat/completions',
          method: 'POST',
          headers: {
            host: 'app.kilo.sh',
            cookie: Object.entries(cookies)
              .map(([name, value]) => `${name}=${value}`)
              .join('; '),
            ...Object.fromEntries(
              CREDENTIAL_HEADER_NAMES.map(name => [name, fakeCredential(name)])
            ),
          },
          cookies,
        },
      });
      captureException(new Error('completion failed'));
    });

    const [event] = await sentEvents();

    expect(event?.request?.cookies).toBeUndefined();
    expect(event?.request?.headers?.host).toBe('app.kilo.sh');
    const envelopes = JSON.stringify(sentEnvelopes);
    for (const name of [...CREDENTIAL_HEADER_NAMES, ...CREDENTIAL_COOKIE_NAMES]) {
      expect(envelopes).not.toContain(fakeCredential(name));
    }
  });

  test('filters a private key in a captured message', async () => {
    withIsolationScope(() => {
      captureMessage(`signing failed with ${PRIVATE_KEY}`);
    });

    const [event] = await sentEvents();

    expect(event?.message).toBe('signing failed with [Filtered]');
    expectNoFakeValue(event);
  });

  // beforeSend does not see transactions or streamed spans. The server sends
  // neither, because tracing is off; a span name can carry a URL.
  test('sends no transaction or span when code starts a span', async () => {
    withIsolationScope(() => {
      startSpan({ name: `GET ${TOKEN_URL}`, forceTransaction: true }, () => {
        captureException(new Error('inside a span'));
      });
    });

    await flush(2000);
    const types = sentEnvelopes.flatMap(([, items]) => items.map(([header]) => header.type));

    expect(types).toContain('event');
    expect(types).not.toContain('transaction');
    expect(types).not.toContain('span');
    expectNoFakeValue(sentEnvelopes);
  });
});

describe('initServerSentry keeps credentials out of the request and the trace', () => {
  test('filters capability paths in the request URL and in kept headers', async () => {
    withIsolationScope(scope => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          url: INVITE_URL,
          method: 'GET',
          headers: {
            host: 'app.kilo.sh',
            referer: SHARE_REFERER,
            'x-pathname': new URL(INVITE_URL).pathname,
          },
        },
      });
      captureException(new Error('invitation failed'));
    });

    const [event] = await sentEvents();

    expect(event?.request?.url).toBe('https://app.kilo.sh/users/accept-invite/:token');
    expect(event?.request?.headers).toEqual({
      host: 'app.kilo.sh',
      referer: 'https://app.kilo.sh/s/:share_token',
      'x-pathname': '/users/accept-invite/:token',
    });
    const serialized = JSON.stringify(sentEnvelopes);
    expect(serialized).not.toContain(FAKE_INVITE_TOKEN);
    expect(serialized).not.toContain(FAKE_SHARE_TOKEN);
  });

  test('builds no transaction when an incoming trace header asks for sampling', async () => {
    withIsolationScope(() => {
      continueTrace({ sentryTrace: SAMPLED_TRACE_HEADER, baggage: undefined }, () => {
        startSpan({ name: 'GET /api/models', forceTransaction: true }, () => {
          captureException(new Error('traced request failed'));
        });
      });
    });
    await flush(2000);

    const types = sentEnvelopes.flatMap(([, items]) => items.map(([header]) => header.type));
    expect(types).toContain('event');
    expect(types).not.toContain('transaction');
    expect(types).not.toContain('span');
  });

  // A sampler that would sample proves the backstop alone keeps spans out.
  test('sends no span even when the sampler would sample one', async () => {
    const options = getClient()?.getOptions();
    const sampler = options?.tracesSampler;
    if (options) options.tracesSampler = () => 1;
    try {
      withIsolationScope(() => {
        startSpan({ name: 'GET /api/models', forceTransaction: true }, () => {
          captureException(new Error('sampled request failed'));
        });
      });
      await flush(2000);
    } finally {
      if (options) options.tracesSampler = sampler;
    }

    const types = sentEnvelopes.flatMap(([, items]) => items.map(([header]) => header.type));
    expect(types).toContain('event');
    expect(types).not.toContain('transaction');
    expect(types).not.toContain('span');
  });

  test('filters a one-time code tag and keeps a database state tag', async () => {
    withIsolationScope(scope => {
      scope.setTag('verificationCode', ONE_TIME_CODE);
      scope.setTag('databaseErrorCode', '23505');
      captureException(new Error('verification failed'));
    });

    const [event] = await sentEvents();

    expect(event?.tags).toMatchObject({
      verificationCode: '[Filtered]',
      databaseErrorCode: '23505',
    });
  });
});
