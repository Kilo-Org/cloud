import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import type * as SentryNextjs from '@sentry/nextjs';
import type { Event, NodeOptions } from '@sentry/nextjs';
import {
  addBreadcrumb,
  captureException,
  close,
  flush,
  withIsolationScope,
  withScope,
} from '@sentry/nextjs';
import { initServerSentry } from '@kilocode/web-shared/lib/observability/sentry-server';

type Transport = ReturnType<NonNullable<NodeOptions['transport']>>;
type Envelope = Parameters<Transport['send']>[0];

const sentEnvelopes: Envelope[] = [];

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

const FAKE_SECRET = 'fake-secret-value-0000';
// Kept away from the capture calls, because the SDK sends nearby source lines
// as stack frame context.
const FAKE_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.ZmFrZS1zaWduYXR1cmU';

type SentItem = { type: string; payload: unknown };

async function sentItems(): Promise<SentItem[]> {
  await flush(2000);
  return sentEnvelopes.flatMap(([, items]) =>
    items.map(([header, payload]) => ({ type: String(header.type), payload }))
  );
}

async function sentEvents(): Promise<Event[]> {
  return (await sentItems())
    .filter(item => item.type === 'event')
    .map(item => item.payload as Event);
}

let silencedConsole: jest.SpiedFunction<typeof console.warn>[];

beforeAll(() => {
  // Silence the console before init, so the SDK console instrumentation wraps
  // the silent stubs and still sees every call.
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

describe('initServerSentry through the real SDK pipeline', () => {
  test('sends no console output to Sentry', async () => {
    console.warn('metadata', { password: FAKE_SECRET });
    console.error(`request failed for ${FAKE_SECRET}`);

    const items = await sentItems();

    expect(items.map(item => item.type)).not.toContain('log');
    expect(JSON.stringify(items)).not.toContain(FAKE_SECRET);
  });

  test('sends no console breadcrumbs with an event', async () => {
    withIsolationScope(() => {
      console.warn('x', { password: 'fake' });
      console.error(`retry with ${FAKE_SECRET}`);
      captureException(new Error('request failed'));
    });

    const [event] = await sentEvents();

    expect(event?.breadcrumbs?.filter(crumb => crumb.category === 'console') ?? []).toEqual([]);
    expect(JSON.stringify(event?.breadcrumbs ?? [])).not.toContain(FAKE_SECRET);
  });

  test('keeps other breadcrumbs and scrubs them', async () => {
    withIsolationScope(() => {
      addBreadcrumb({
        category: 'fetch',
        message: `GET /api/models Bearer ${FAKE_JWT}`,
        data: { method: 'GET', status_code: 401, authorization: 'fake' },
      });
      captureException(new Error('request failed'));
    });

    const [event] = await sentEvents();

    expect(
      event?.breadcrumbs?.map(({ category, message, data }) => ({ category, message, data }))
    ).toEqual([
      {
        category: 'fetch',
        message: 'GET /api/models Bearer [Filtered]',
        data: { method: 'GET', status_code: 401, authorization: '[Filtered]' },
      },
    ]);
  });

  test('drops a token nested in a callbackPath query value', async () => {
    const callbackPath = `/pages-auth?audience=pages&state=${FAKE_SECRET}`;
    const query = new URLSearchParams({ callbackPath, plan: 'pro' }).toString();

    withIsolationScope(scope => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          url: `https://app.kilo.sh/users/sign_in?${query}`,
          query_string: query,
          headers: { host: 'app.kilo.sh', 'x-search': `?${query}` },
        },
      });
      captureException(new Error('sign-in failed'));
    });

    const [event] = await sentEvents();

    expect(event?.request).toEqual({
      url: 'https://app.kilo.sh/users/sign_in?plan=pro',
      query_string: 'plan=pro',
      headers: { host: 'app.kilo.sh', 'x-search': '[Filtered]' },
    });
  });

  test('sends only the user id', async () => {
    withScope(scope => {
      scope.setUser({
        id: 'user-fake-0123',
        email: 'person@example.com',
        ip_address: '192.0.2.44',
        username: FAKE_SECRET,
      });
      captureException(new Error('lookup failed'));
    });

    const [event] = await sentEvents();

    expect(event?.user).toEqual({ id: 'user-fake-0123' });
  });

  test('redacts a secret in the Drizzle error fingerprint', async () => {
    const query = 'select 1';
    captureException(
      Object.assign(new Error(`Failed query: ${query}`), {
        query,
        params: [],
        cause: { code: '22P02', message: `invalid input syntax for type uuid: "${FAKE_JWT}"` },
      })
    );

    const [event] = await sentEvents();

    expect(event?.fingerprint).toEqual([
      'drizzle-query-error',
      '22P02',
      'invalid input syntax for type uuid: "[Filtered]"',
    ]);
    expect(JSON.stringify(event)).not.toContain(FAKE_JWT);
  });
});
