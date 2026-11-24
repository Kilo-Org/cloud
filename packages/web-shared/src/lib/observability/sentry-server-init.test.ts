import { beforeAll, describe, expect, test } from '@jest/globals';
import type { ErrorEvent, EventHint, Log } from '@sentry/nextjs';
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
  consoleLoggingIntegration: jest.fn(() => ({ name: 'ConsoleLogs' })),
  httpIntegration: jest.fn(() => ({ name: 'Http' })),
}));

const FAKE_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.ZmFrZS1zaWduYXR1cmU';

type BeforeSend = (event: ErrorEvent, hint: EventHint) => ErrorEvent | null;
type BeforeSendLog = (log: Log) => Log | null;

let beforeSend: BeforeSend;
let beforeSendLog: BeforeSendLog;

beforeAll(() => {
  initServerSentry();
  const options = jest.mocked(init).mock.calls[0]?.[0] as {
    beforeSend?: BeforeSend;
    beforeSendLog?: BeforeSendLog;
  };
  if (!options.beforeSend || !options.beforeSendLog) {
    throw new Error('initServerSentry did not register beforeSend and beforeSendLog');
  }
  beforeSend = options.beforeSend;
  beforeSendLog = options.beforeSendLog;
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

describe('server Sentry beforeSendLog', () => {
  test('redacts the log message and scrubs its attributes', () => {
    const result = beforeSendLog({
      level: 'error',
      message: `openrouter returned error 401 Bearer ${FAKE_JWT}`,
      attributes: {
        'sentry.origin': 'auto.log.console',
        'sentry.message.template': `openrouter returned error 401 Bearer ${FAKE_JWT}`,
        'sentry.message.parameter.0': { authorization: 'fake', first4kOfResponse: FAKE_JWT },
        'user.id': 'user-fake-0123',
      },
    });

    expect(result).toEqual({
      level: 'error',
      message: 'openrouter returned error 401 Bearer [Filtered]',
      attributes: {
        'sentry.origin': 'auto.log.console',
        'sentry.message.template': 'openrouter returned error 401 Bearer [Filtered]',
        'sentry.message.parameter.0': {
          authorization: '[Filtered]',
          first4kOfResponse: '[Filtered]',
        },
        'user.id': 'user-fake-0123',
      },
    });
  });

  test('keeps a log without secrets unchanged', () => {
    const log: Log = { level: 'info', message: 'model anthropic/claude-sonnet-4 ready' };

    expect(beforeSendLog(log)).toEqual(log);
  });
});
