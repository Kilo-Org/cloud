import { beforeAll, describe, expect, test } from '@jest/globals';
import type { ErrorEvent, EventHint } from '@sentry/nextjs';
import { captureMessage, init } from '@sentry/nextjs';
import { initServerSentry } from '@kilocode/web-shared/lib/observability/sentry-server';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import {
  expectScrubbedServerEvent,
  leakyServerEvent,
} from '@kilocode/web-shared/tests/helpers/sentry-event.helper';

jest.mock('@sentry/nextjs', () => ({
  init: jest.fn(),
  captureMessage: jest.fn(),
  httpIntegration: jest.fn(() => ({ name: 'Http' })),
}));

const FAKE_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.ZmFrZS1zaWduYXR1cmU';

type BeforeSend = (event: ErrorEvent, hint: EventHint) => ErrorEvent | null;

let beforeSend: BeforeSend;

beforeAll(() => {
  initServerSentry();
  const options = jest.mocked(init).mock.calls[0]?.[0] as {
    beforeSend?: BeforeSend;
  };
  if (!options.beforeSend) {
    throw new Error('initServerSentry did not register beforeSend');
  }
  beforeSend = options.beforeSend;
});

function errorEvent(event: Omit<ErrorEvent, 'type'>): ErrorEvent {
  return { type: undefined, ...event };
}

describe('server Sentry beforeSend', () => {
  test('removes every credential from a realistic server event', () => {
    expectScrubbedServerEvent(beforeSend(leakyServerEvent(), {}));
  });

  test('scrubs sentryLogger arguments sent in extra.args', () => {
    jest.mocked(captureMessage).mockClear();

    sentryLogger('fake-source', 'error')(
      'upstream rejected the request',
      { authorization: `Bearer ${FAKE_JWT}`, status: 401 },
      `retry with ${FAKE_JWT}`
    );

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, captureContext] = jest.mocked(captureMessage).mock.calls[0];
    const context = captureContext as {
      level: ErrorEvent['level'];
      tags: ErrorEvent['tags'];
      extra: ErrorEvent['extra'];
    };
    const result = beforeSend(
      errorEvent({ message, level: context.level, tags: context.tags, extra: context.extra }),
      {}
    );

    expect(result?.extra).toEqual({
      args: [{ authorization: '[Filtered]', status: 401 }, 'retry with [Filtered]'],
    });
    expect(result?.tags).toEqual({ source: 'fake-source' });
    expect(JSON.stringify(result)).not.toContain(FAKE_JWT);
  });

  test('removes local variables from stack frames', () => {
    const result = beforeSend(
      errorEvent({
        exception: {
          values: [
            {
              type: 'Error',
              value: 'request failed',
              stacktrace: {
                frames: [
                  { function: 'handler', lineno: 4, vars: { apiKey: 'fake-key', count: 2 } },
                  { function: 'route', lineno: 9 },
                ],
              },
            },
          ],
        },
      }),
      {}
    );

    expect(result?.exception?.values?.[0]?.stacktrace?.frames).toEqual([
      { function: 'handler', lineno: 4 },
      { function: 'route', lineno: 9 },
    ]);
  });

  test('removes the request environment', () => {
    const result = beforeSend(
      errorEvent({
        request: { url: 'https://app.kilo.sh/api', env: { REMOTE_ADDR: '192.0.2.44' } },
      }),
      {}
    );

    expect(result?.request).toEqual({ url: 'https://app.kilo.sh/api' });
  });

  test.each([
    [
      'keeps only the user id',
      { id: 'user-fake-0123', email: 'person@example.com', ip_address: '192.0.2.44' },
      { user: { id: 'user-fake-0123' } },
    ],
    ['removes a user without an id', { email: 'person@example.com' }, {}],
  ])('%s', (_name, user, expected) => {
    const result = beforeSend(errorEvent({ user }), {});

    expect(result).toEqual({ type: undefined, ...expected });
  });

  test('still drops tRPC 4xx errors', () => {
    const error = Object.assign(new Error('not allowed'), { code: 'UNAUTHORIZED' });

    expect(beforeSend(leakyServerEvent(), { originalException: error })).toBeNull();
  });

  test('still rewrites Drizzle query errors and scrubs the query context', () => {
    const query = `select * from "byok_api_keys" where "api_key" = '${FAKE_JWT}'`;
    const error = Object.assign(new Error(`Failed query: ${query}`), {
      query,
      params: [],
      cause: { code: '57014', message: 'canceling statement due to statement timeout' },
    });
    const event = errorEvent({
      exception: { values: [{ type: 'Error', value: `Failed query: ${query}` }] },
    });

    const result = beforeSend(event, { originalException: error });

    expect(result?.fingerprint).toEqual([
      'drizzle-query-error',
      '57014',
      'canceling statement due to statement timeout',
    ]);
    expect(result?.tags).toEqual({ 'db.error_code': '57014' });
    expect(result?.exception?.values).toEqual([
      { type: 'PostgresError', value: 'canceling statement due to statement timeout' },
    ]);
    expect(result?.contexts?.drizzle_query).toEqual({
      query: `select * from "byok_api_keys" where "api_key" = '[Filtered]'`,
      wrapper_message: `Failed query: select * from "byok_api_keys" where "api_key" = '[Filtered]'`,
    });
  });
});
