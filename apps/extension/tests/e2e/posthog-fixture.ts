/* eslint-disable import/no-nodejs-modules, promise/avoid-new */
import type { BrowserContext, Request } from '@playwright/test';
import { gunzipSync } from 'node:zlib';

export interface NormalizedPosthogEvent {
  readonly distinctId: string | undefined;
  readonly event: string;
  readonly properties: Record<string, unknown>;
}

export interface PosthogRecorder {
  readonly events: NormalizedPosthogEvent[];
  readonly flagsOrDecideHits: string[];
}

/**
 * PostHog drops capture when the UA contains `HeadlessChrome` or
 * `navigator.webdriver` is truthy. Chrome E2E must look like a normal browser.
 */
export const EXTENSION_E2E_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

export const EXTENSION_E2E_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--enable-features=WebMCP',
] as const;

export const applyPosthogE2eBrowserWorkarounds = async (context: BrowserContext): Promise<void> => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      configurable: true,
      // eslint-disable-next-line unicorn/no-useless-undefined -- must be undefined, not false/null
      get: () => undefined,
    });
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readRequestBodyText = (request: Request): string | undefined => {
  const buffer = request.postDataBuffer();
  if (buffer === null || buffer.length === 0) {
    return request.postData() ?? undefined;
  }

  const url = request.url();
  // Gzip magic bytes 0x1F 0x8B
  const isGzip = url.includes('compression=gzip') || (buffer[0] === 31 && buffer[1] === 139);

  if (isGzip) {
    return gunzipSync(buffer).toString('utf8');
  }

  return buffer.toString('utf8');
};

const coerceBodyEntries = (body: unknown): unknown[] => {
  if (Array.isArray(body)) {
    return body;
  }

  if (isRecord(body) && Array.isArray(body['batch'])) {
    return body['batch'];
  }

  if (body === undefined || body === null) {
    return [];
  }

  return [body];
};

/**
 * Normalize a parsed PostHog request body into capture events.
 *
 * Observed `posthog-js@1.360.2` shapes (with `advanced_disable_flags: true`):
 * - Single event object: `{ event, properties, $set?, ... }` (identify / send_instantly)
 * - Top-level array of event objects (default request batching flush)
 * - `{ batch: [...] }` envelope (defensive)
 *
 * Bodies may arrive gzip-compressed (`compression=gzip-js` query param) even when
 * `/flags` is disabled — decompress before JSON.parse.
 */
export const normalizePosthogBody = (body: unknown): NormalizedPosthogEvent[] => {
  const normalized: NormalizedPosthogEvent[] = [];

  for (const entry of coerceBodyEntries(body)) {
    if (isRecord(entry)) {
      const eventName = entry['event'];
      if (typeof eventName === 'string' && eventName.length > 0) {
        const properties = isRecord(entry['properties']) ? entry['properties'] : {};
        const distinctIdRaw = properties['distinct_id'];

        normalized.push({
          distinctId: typeof distinctIdRaw === 'string' ? distinctIdRaw : undefined,
          event: eventName,
          properties,
        });
      }
    }
  }

  return normalized;
};

const asEventList = (
  recorder: PosthogRecorder | readonly NormalizedPosthogEvent[]
): readonly NormalizedPosthogEvent[] => {
  if ('events' in recorder) {
    return recorder.events;
  }

  return recorder;
};

export const findCapturedEvent = (
  recorder: PosthogRecorder | readonly NormalizedPosthogEvent[],
  eventName: string
): NormalizedPosthogEvent | undefined =>
  asEventList(recorder).find(event => event.event === eventName);

export const findCapturedEvents = (
  recorder: PosthogRecorder | readonly NormalizedPosthogEvent[],
  eventName: string
): NormalizedPosthogEvent[] => asEventList(recorder).filter(event => event.event === eventName);

const flagsResponseBody = JSON.stringify({
  errorsWhileComputingFlags: false,
  featureFlagPayloads: {},
  featureFlags: {},
});

const captureResponseBody = JSON.stringify({ status: 1 });

const isFlagsOrDecidePath = (pathname: string): boolean =>
  pathname.includes('/flags') || pathname.includes('/decide');

const isCapturePath = (pathname: string): boolean =>
  pathname.includes('/e') ||
  pathname.includes('/batch') ||
  pathname.includes('/capture') ||
  pathname.includes('/engage');

/**
 * Route all PostHog host traffic, fulfill expected shapes, and record normalized
 * capture events. Tracks `/flags` and legacy `/decide/` hits separately so tests
 * can assert the SDK emits zero such traffic with `advanced_disable_flags: true`.
 */
export const installPosthogStub = async (context: BrowserContext): Promise<PosthogRecorder> => {
  const events: NormalizedPosthogEvent[] = [];
  const flagsOrDecideHits: string[] = [];
  const recorder: PosthogRecorder = { events, flagsOrDecideHits };

  await context.route('https://us.i.posthog.com/**', async route => {
    const request = route.request();
    const url = request.url();
    const { pathname } = new URL(url);

    if (isFlagsOrDecidePath(pathname)) {
      flagsOrDecideHits.push(url);
      await route.fulfill({
        body: flagsResponseBody,
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (isCapturePath(pathname) || request.method() === 'POST') {
      const text = readRequestBodyText(request);
      if (text !== undefined && text.length > 0) {
        try {
          const parsed: unknown = JSON.parse(text);
          events.push(...normalizePosthogBody(parsed));
        } catch {
          // Non-JSON bodies still fulfill so the SDK does not retry forever.
        }
      }
    }

    await route.fulfill({
      body: captureResponseBody,
      contentType: 'application/json',
      status: 200,
    });
  });

  return recorder;
};
