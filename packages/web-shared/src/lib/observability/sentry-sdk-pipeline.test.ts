import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import type * as SentryNextjs from '@sentry/nextjs';
import type { Event, NodeOptions } from '@sentry/nextjs';
import {
  addBreadcrumb,
  captureException,
  captureMessage,
  captureRequestError,
  close,
  flush,
  trpcMiddleware,
  withIsolationScope,
  withScope,
} from '@sentry/nextjs';
import { initTRPC } from '@trpc/server';
import { DrizzleQueryError } from 'drizzle-orm';
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
const FAKE_DB_INPUT = 'fake-database-input-0000';

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

async function sentEventFor(errorMessage: string): Promise<Event | undefined> {
  return (await sentEvents()).find(event =>
    event.exception?.values?.some(exception => exception.value === errorMessage)
  );
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

    // The SDK query allow list filters every value before beforeSend runs.
    expect(event?.request).toEqual({
      url: 'https://app.kilo.sh/users/sign_in?callbackPath=[Filtered]&plan=[Filtered]',
      query_string: 'callbackPath=[Filtered]&plan=[Filtered]',
      headers: { host: 'app.kilo.sh', 'x-search': '[Filtered]' },
    });
  });

  test('filters the query values of a request URL', async () => {
    const input = encodeURIComponent(JSON.stringify({ json: { share_token: FAKE_JWT } }));
    const query = `input=${input}`;

    withIsolationScope(scope => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          url: `https://app.kilo.sh/api/trpc/cliSessionsV2.getSharedSession?${query}`,
          query_string: query,
        },
      });
      captureException(new Error('share lookup failed'));
    });

    const [event] = await sentEvents();

    expect(event?.request).toEqual({
      url: 'https://app.kilo.sh/api/trpc/cliSessionsV2.getSharedSession?input=[Filtered]',
      query_string: 'input=[Filtered]',
      headers: {},
    });
  });

  test.each([
    [
      'a nested callbackPath query',
      `/users/sign_in?${new URLSearchParams({
        callbackPath: `/pages-auth?audience=pages&state=${FAKE_SECRET}`,
      }).toString()}`,
      '/users/sign_in?callbackPath=[Filtered]',
    ],
    ['a share token path', `/s/${FAKE_JWT}`, '/s/:share_token'],
  ])(
    'applies the URL policy to the request path of %s in captureRequestError',
    async (name, path, expected) => {
      captureRequestError(
        new Error(`render failed: ${name}`),
        { path, method: 'GET', headers: { host: 'app.kilo.sh' } },
        { routerKind: 'App Router', routePath: '/users/sign_in', routeType: 'render' }
      );

      const event = await sentEventFor(`render failed: ${name}`);

      expect(event?.contexts?.nextjs).toEqual({
        request_path: expected,
        router_kind: 'App Router',
        router_path: '/users/sign_in',
        route_type: 'render',
      });
    }
  );

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

  test('sends a Drizzle query error without bound values or database input', async () => {
    const query = 'update "dolthub_installations" set "access_token" = $1 where "id" = $2';
    captureException(
      new DrizzleQueryError(
        query,
        [FAKE_SECRET, 'installation-1'],
        Object.assign(new Error(`invalid input syntax for type uuid: "${FAKE_DB_INPUT}"`), {
          code: '22P02',
        })
      )
    );

    const event = await sentEventFor('invalid input syntax for type uuid: "[Filtered]"');

    expect(event?.fingerprint).toEqual(['drizzle-query-error', '22P02', 'PostgresError']);
    expect(event?.exception?.values?.map(({ type, value }) => ({ type, value }))).toEqual([
      { type: 'PostgresError', value: 'invalid input syntax for type uuid: "[Filtered]"' },
    ]);
    expect(event?.contexts?.drizzle_query).toEqual({ query });
    expect(JSON.stringify(event)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(event)).not.toContain(FAKE_DB_INPUT);
  });

  test('sends a Drizzle query error without a cause and without bound values', async () => {
    const query = 'insert into "kilocode_users" ("email") values ($1)';
    captureException(new DrizzleQueryError(query, [FAKE_SECRET]));

    const event = await sentEventFor(`Failed query: ${query}`);

    expect(event?.fingerprint).toEqual(['drizzle-query-error', 'generic', 'DrizzleQueryError']);
    expect(event?.contexts?.drizzle_query).toEqual({ query });
    expect(JSON.stringify(event)).not.toContain(FAKE_SECRET);
  });

  test('sends a tRPC procedure error with safe database diagnostics', async () => {
    const query = 'select * from items where id = $1';
    const cause = Object.assign(
      new Error(`invalid input syntax for type uuid: "${FAKE_DB_INPUT}"`),
      {
        code: '22P02',
      }
    );
    const t = initTRPC.create();
    const caller = t
      .router({
        lookup: t.procedure.use(trpcMiddleware({ attachRpcInput: false })).query(() => {
          throw new DrizzleQueryError(query, [FAKE_SECRET], cause);
        }),
      })
      .createCaller({});

    await expect(caller.lookup()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

    const [event] = await sentEvents();
    expect(event).toBeDefined();
    expect(JSON.stringify(event)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(event)).not.toContain(FAKE_DB_INPUT);
    expect(event?.fingerprint).toEqual(['drizzle-query-error', '22P02', 'PostgresError']);
    expect(event?.tags).toMatchObject({ 'db.error_code': '22P02' });
    expect(event?.contexts?.drizzle_query).toEqual({ query });
    expect(event?.contexts?.trpc).toEqual({ procedure_path: 'lookup', procedure_type: 'query' });
    expect(event?.exception?.values).toHaveLength(1);
    expect(event?.exception?.values?.[0]).toMatchObject({
      type: 'PostgresError',
      value: 'invalid input syntax for type uuid: "[Filtered]"',
      stacktrace: { frames: expect.any(Array) },
      mechanism: { handled: false, type: 'auto.rpc.trpc.middleware' },
    });
  });

  test('removes bound values from formatted query errors in event text', async () => {
    const query = 'select *\nfrom items where id = $1';
    const error = new DrizzleQueryError(query, [`${FAKE_SECRET}\n${FAKE_DB_INPUT}`]);
    const expected = `Failed query: ${query}`;
    withIsolationScope(scope => {
      scope.setExtra('args', [{ message: error.message }]);
      addBreadcrumb({ category: 'app', message: `lookup failed: ${error.message}` });
      captureMessage(`lookup failed: ${error.message}`);
    });

    const [event] = await sentEvents();
    expect(event?.message).toBe(`lookup failed: ${expected}`);
    expect(event?.extra?.args).toEqual([{ message: expected }]);
    expect(event?.breadcrumbs?.[0]?.message).toBe(`lookup failed: ${expected}`);
    expect(JSON.stringify(event)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(event)).not.toContain(FAKE_DB_INPUT);
  });

  test('omits bound values from query error extras and keeps unrelated params', async () => {
    const query = 'select * from items where id = $1';
    const cause = Object.assign(new Error(`Invalid input: ${FAKE_DB_INPUT}`), {
      code: '22P02',
    });
    captureMessage('lookup failed', {
      extra: {
        error: new DrizzleQueryError(query, [FAKE_SECRET], cause),
        diagnostics: { query, params: ['test-mode'] },
      },
    });

    const [event] = await sentEvents();
    expect(event?.extra).toMatchObject({
      error: { query, message: `Failed query: ${query}` },
      diagnostics: { query, params: ['test-mode'] },
    });
    const serializedEvent = JSON.stringify(event);
    expect(serializedEvent.includes(FAKE_SECRET)).toBe(false);
    expect(serializedEvent.includes(FAKE_DB_INPUT)).toBe(false);
  });
});
