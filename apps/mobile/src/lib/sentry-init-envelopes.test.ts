/* eslint-disable eslint-plugin-import/no-nodejs-modules -- the app does not list @sentry/core, so this test resolves the copy the React Native SDK loads */
import { createRequire } from 'node:module';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reinitSentryForConsent } from '@/lib/sentry-consent';
import { initSentry } from '@/lib/sentry-init';

const captured = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }));

vi.mock('@sentry/react-native', () => ({
  init: vi.fn((options: Record<string, unknown>) => {
    captured.options = options;
  }),
  getClient: vi.fn(),
  expoRouterIntegration: vi.fn(() => ({ name: 'ExpoRouter' })),
  extraErrorDataIntegration: vi.fn(() => ({ name: 'ExtraErrorData' })),
  deeplinkIntegration: vi.fn(() => ({ name: 'Deeplink' })),
  mobileReplayIntegration: vi.fn(() => ({ name: 'MobileReplay' })),
  hermesProfilingIntegration: vi.fn(() => ({ name: 'HermesProfiling' })),
  setUser: vi.fn(),
  setTag: vi.fn(),
}));

vi.mock('expo', () => ({ isRunningInExpoGo: vi.fn(() => false) }));

vi.mock('react-native', () => ({ Platform: { OS: 'ios', Version: '18.0' } }));

vi.stubGlobal('__DEV__', false);

type TransportRequest = { body: string | Uint8Array };
type CoreClient = {
  init: () => void;
  captureEvent: (event: Record<string, unknown>) => string;
  flush: (timeout: number) => Promise<boolean>;
};
type SentryCore = {
  Client: new (options: Record<string, unknown>) => CoreClient;
  createTransport: (
    options: unknown,
    send: (request: TransportRequest) => Promise<{ statusCode: number }>
  ) => unknown;
};

// The React Native SDK does not load under node, but its own `@sentry/core`
// does: the base client runs the same hook dispatch and envelope build.
const requireFromApp = createRequire(import.meta.url);
const sentryCore = createRequire(requireFromApp.resolve('@sentry/react-native'))(
  '@sentry/core'
) as SentryCore;

/** Send one event through a core client built from the captured init options. */
async function sendThroughInitOptions(event: Record<string, unknown>): Promise<unknown> {
  const payloads: string[] = [];
  const client = new sentryCore.Client({
    ...captured.options,
    dsn: 'https://public@o0.ingest.sentry.io/1',
    integrations: [],
    stackParser: () => [],
    transport: (options: unknown) =>
      sentryCore.createTransport(options, request => {
        payloads.push(
          typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body)
        );
        return Promise.resolve({ statusCode: 200 });
      }),
  });
  client.init();
  client.captureEvent(event);
  await client.flush(1000);
  expect(payloads).toHaveLength(1);
  const item = (payloads[0] ?? '').split('\n')[2];
  return JSON.parse(item ?? 'null');
}

const leakyRequest = () => ({
  url: 'https://api.example.com/trpc/user.get?input=fake-query-value',
  headers: { Authorization: 'Bearer fake-token-value', 'User-Agent': 'kilo-app/1.0' },
});

const scrubbedRequest = {
  url: 'https://api.example.com/trpc/user.get',
  headers: { 'User-Agent': 'kilo-app/1.0' },
};

const leakySpanData = () => ({
  url: 'https://api.example.com/trpc/user.get?input=fake-query-value',
  'http.url': 'https://api.example.com/trpc/user.get?input=fake-query-value',
  'url.full': 'https://api.example.com/trpc/user.get?input=fake-query-value',
  'http.query': '?input=fake-query-value',
  'url.query': 'input=fake-query-value',
  'http.fragment': '#fake-fragment-value',
  'http.request.header.authorization': 'Bearer fake-token-value',
  'http.request.header.user-agent': 'kilo-app/1.0',
  'http.response.header.set-cookie': 'session=fake-cookie-value',
  'http.method': 'GET',
});

const scrubbedSpanData = {
  url: 'https://api.example.com/trpc/user.get',
  'http.url': 'https://api.example.com/trpc/user.get',
  'url.full': 'https://api.example.com/trpc/user.get',
  'http.request.header.user-agent': 'kilo-app/1.0',
  'http.method': 'GET',
};

const TRACE_ID = 'a'.repeat(32);

describe.each(['the declined module-scope init', 'the consented re-init'])(
  'Sentry envelopes after %s',
  initPath => {
    beforeEach(async () => {
      captured.options = undefined;
      if (initPath === 'the declined module-scope init') {
        initSentry(false);
      } else {
        await reinitSentryForConsent(true, initSentry);
      }
    });

    it('scrubs the request of an error event', async () => {
      const payload = await sendThroughInitOptions({ message: 'boom', request: leakyRequest() });

      expect(payload).toMatchObject({ request: scrubbedRequest });
      expect(JSON.stringify(payload)).not.toContain('fake-');
    });

    it('scrubs the request and span data of a transaction event', async () => {
      const payload = await sendThroughInitOptions({
        type: 'transaction',
        transaction: 'agent-chat',
        start_timestamp: 1,
        timestamp: 2,
        request: leakyRequest(),
        contexts: { trace: { trace_id: TRACE_ID, span_id: 'b'.repeat(16), data: leakySpanData() } },
        spans: [
          {
            trace_id: TRACE_ID,
            span_id: 'c'.repeat(16),
            parent_span_id: 'b'.repeat(16),
            start_timestamp: 1,
            timestamp: 2,
            op: 'http.client',
            description: 'GET https://api.example.com/trpc/user.get',
            data: leakySpanData(),
          },
        ],
      });

      expect(payload).toMatchObject({
        request: scrubbedRequest,
        contexts: { trace: { data: scrubbedSpanData } },
        spans: [{ data: scrubbedSpanData }],
      });
      expect(JSON.stringify(payload)).not.toContain('fake-');
    });
  }
);
