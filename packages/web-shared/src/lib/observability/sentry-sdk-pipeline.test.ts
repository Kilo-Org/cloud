import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import type * as SentryNextjs from '@sentry/nextjs';
import type { Envelope, Event, NodeOptions, Transport } from '@sentry/nextjs';
import { captureException, close, flush, withIsolationScope } from '@sentry/nextjs';
import { initServerSentry } from '@kilocode/web-shared/lib/observability/sentry-server';

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
});
