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
  getCurrentScope: () => { setClient: (client: CoreClient) => void };
  getIsolationScope: () => { clear: () => void };
  addBreadcrumb: (breadcrumb: Record<string, unknown>) => void;
  captureEvent: (event: Record<string, unknown>) => string;
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

/**
 * Record the breadcrumbs, then send one event, through a core client built
 * from the captured init options.
 */
async function sendThroughInitOptions(
  event: Record<string, unknown>,
  breadcrumbs: readonly Record<string, unknown>[] = []
): Promise<unknown> {
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
  sentryCore.getIsolationScope().clear();
  sentryCore.getCurrentScope().setClient(client);
  client.init();
  for (const breadcrumb of breadcrumbs) {
    sentryCore.addBreadcrumb(breadcrumb);
  }
  sentryCore.captureEvent(event);
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

const FAKE_SHARE_JWT = 'eyJhbGciOiJub25lIn0.eyJmYWtlIjoic2hhcmUifQ.fake-signature';
const SHARE_LINK = `https://app.kilo.ai/s/${FAKE_SHARE_JWT}`;
const SCRUBBED_SHARE_LINK = 'https://app.kilo.ai/s/[redacted]';
const APP_SHARE_PATH = `/shared/${FAKE_SHARE_JWT}`;

/** The breadcrumbs the SDK's deep link and navigation integrations record. */
const shareLinkBreadcrumbs = [
  { category: 'deeplink', type: 'navigation', message: SHARE_LINK, data: { url: SHARE_LINK } },
  {
    category: 'navigation',
    type: 'navigation',
    message: `Navigation to ${APP_SHARE_PATH}`,
    data: { from: 'home', to: APP_SHARE_PATH },
  },
];

const scrubbedShareBreadcrumbs = [
  { category: 'deeplink', message: SCRUBBED_SHARE_LINK, data: { url: SCRUBBED_SHARE_LINK } },
  {
    category: 'navigation',
    message: 'Navigation to /shared/[redacted]',
    data: { from: 'home', to: '/shared/[redacted]' },
  },
];

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

    it('redacts a share token from an error, its request, and its breadcrumbs', async () => {
      const payload = await sendThroughInitOptions(
        { message: 'boom', request: { url: SHARE_LINK } },
        shareLinkBreadcrumbs
      );

      expect(payload).toMatchObject({
        request: { url: SCRUBBED_SHARE_LINK },
        breadcrumbs: scrubbedShareBreadcrumbs,
      });
      expect(JSON.stringify(payload)).not.toContain('eyJ');
    });

    it('redacts a share token from a navigation transaction, its spans, and its breadcrumbs', async () => {
      const shareSpanData = () => ({
        'deeplink.url': SHARE_LINK,
        url: SHARE_LINK,
        'http.url': SHARE_LINK,
        'url.full': SHARE_LINK,
        'http.target': `/s/${FAKE_SHARE_JWT}`,
        'url.path': APP_SHARE_PATH,
      });
      const scrubbedShareSpanData = {
        'deeplink.url': SCRUBBED_SHARE_LINK,
        url: SCRUBBED_SHARE_LINK,
        'http.url': SCRUBBED_SHARE_LINK,
        'url.full': SCRUBBED_SHARE_LINK,
        'http.target': '/s/[redacted]',
        'url.path': '/shared/[redacted]',
      };

      const payload = await sendThroughInitOptions(
        {
          type: 'transaction',
          transaction: APP_SHARE_PATH,
          start_timestamp: 1,
          timestamp: 2,
          request: { url: SHARE_LINK },
          contexts: {
            trace: { trace_id: TRACE_ID, span_id: 'b'.repeat(16), data: shareSpanData() },
          },
          spans: [
            {
              trace_id: TRACE_ID,
              span_id: 'c'.repeat(16),
              parent_span_id: 'b'.repeat(16),
              start_timestamp: 1,
              timestamp: 2,
              op: 'navigation.processing',
              description: `Navigation dispatch to screen ${APP_SHARE_PATH} mounted`,
              data: shareSpanData(),
            },
          ],
        },
        shareLinkBreadcrumbs
      );

      expect(payload).toMatchObject({
        transaction: '/shared/[redacted]',
        request: { url: SCRUBBED_SHARE_LINK },
        contexts: { trace: { data: scrubbedShareSpanData } },
        spans: [
          {
            description: 'Navigation dispatch to screen /shared/[redacted] mounted',
            data: scrubbedShareSpanData,
          },
        ],
      });
      expect(JSON.stringify(payload)).not.toContain('eyJ');
    });
  }
);
