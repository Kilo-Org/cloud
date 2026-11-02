import { describe, expect, it } from 'vitest';

import {
  buildEventsUrl,
  DSYNC_EVENT_TYPES,
  fetchEventPage,
  lastEventId,
  MAX_PAGE_LIMIT,
  parseRetryAfterMs,
  WorkOSEventPageSchema,
} from '../../src/workos/events';

const BASE_URL = 'https://api.workos.com';

function event(id: string, overrides: Record<string, unknown> = {}) {
  return {
    object: 'event',
    id,
    event: 'dsync.user.created',
    created_at: '2026-11-02T10:00:00.000Z',
    data: { id: 'directory_user_01', state: 'active' },
    ...overrides,
  };
}

function page(ids: string[], after: string | null = null) {
  return {
    object: 'list',
    data: ids.map(id => event(id)),
    list_metadata: { after },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

async function fetchWith(
  response: Response | (() => Response),
  position: Parameters<typeof fetchEventPage>[0]['position'] = {
    kind: 'after',
    after: 'event_01',
  }
) {
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(typeof response === 'function' ? response() : response)) as typeof fetch;
  try {
    return await fetchEventPage({
      baseUrl: BASE_URL,
      apiKey: 'sk_test',
      limit: MAX_PAGE_LIMIT,
      position,
    });
  } finally {
    globalThis.fetch = original;
  }
}

describe('buildEventsUrl', () => {
  it('sends every dsync event type as a repeated required filter', () => {
    const url = new URL(
      buildEventsUrl({
        baseUrl: BASE_URL,
        limit: 100,
        position: { kind: 'after', after: 'event_01' },
      })
    );

    expect(url.searchParams.getAll('events')).toEqual([...DSYNC_EVENT_TYPES]);
    expect(url.pathname).toBe('/events');
  });

  it('never sends after and range_start together', () => {
    const withCursor = new URL(
      buildEventsUrl({
        baseUrl: BASE_URL,
        limit: 100,
        position: { kind: 'after', after: 'event_01' },
      })
    );
    expect(withCursor.searchParams.get('after')).toBe('event_01');
    expect(withCursor.searchParams.has('range_start')).toBe(false);

    const coldStart = new URL(
      buildEventsUrl({
        baseUrl: BASE_URL,
        limit: 100,
        position: { kind: 'range_start', rangeStart: '2026-11-02T10:00:00.000Z' },
      })
    );
    expect(coldStart.searchParams.get('range_start')).toBe('2026-11-02T10:00:00.000Z');
    expect(coldStart.searchParams.has('after')).toBe(false);
  });
});

describe('lastEventId', () => {
  it('takes the cursor from the last event, not list_metadata', () => {
    const parsed = WorkOSEventPageSchema.parse(page(['event_01', 'event_02'], 'event_99'));
    expect(lastEventId(parsed)).toBe('event_02');
  });

  it('returns null for an empty page so a caught-up poll cannot rewind the cursor', () => {
    expect(lastEventId(WorkOSEventPageSchema.parse(page([], null)))).toBeNull();
  });
});

describe('WorkOSEventPageSchema', () => {
  it('accepts a null or absent list_metadata.after at the end of the stream', () => {
    expect(WorkOSEventPageSchema.parse(page([], null)).list_metadata?.after).toBeNull();
    expect(WorkOSEventPageSchema.parse({ object: 'list', data: [] }).list_metadata).toBeUndefined();
  });

  it('accepts differing per-type data payloads without reshaping them', () => {
    const parsed = WorkOSEventPageSchema.parse({
      object: 'list',
      data: [
        event('event_01', {
          event: 'dsync.group.user_added',
          data: { directory_id: 'directory_01', user: { id: 'du_1' }, group: { id: 'dg_1' } },
        }),
        event('event_02', { event: 'dsync.activated', data: { domains: [{ domain: 'a.test' }] } }),
      ],
      list_metadata: { after: null },
    });

    expect(parsed.data[0].data).toEqual({
      directory_id: 'directory_01',
      user: { id: 'du_1' },
      group: { id: 'dg_1' },
    });
    expect(parsed.data[1].event).toBe('dsync.activated');
  });

  it('rejects a response that is not an event list', () => {
    expect(() => WorkOSEventPageSchema.parse({ object: 'list', data: [{ id: 'x' }] })).toThrow();
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');

  it('reads delay-seconds', () => {
    expect(parseRetryAfterMs('30', now)).toBe(30_000);
  });

  it('reads an HTTP date as a delay from now', () => {
    expect(parseRetryAfterMs('Mon, 02 Nov 2026 10:00:45 GMT', now)).toBe(45_000);
  });

  it('clamps a past HTTP date to zero rather than a negative delay', () => {
    expect(parseRetryAfterMs('Mon, 02 Nov 2026 09:59:00 GMT', now)).toBe(0);
  });

  it('returns null for an absent or unparseable header', () => {
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs('  ', now)).toBeNull();
    expect(parseRetryAfterMs('soon', now)).toBeNull();
  });
});

describe('fetchEventPage classification', () => {
  it('returns a validated page on success', async () => {
    const result = await fetchWith(
      jsonResponse(page(['event_01']), {
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' },
      })
    );

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') throw new Error('expected a page');
    expect(result.page.data[0].id).toBe('event_01');
    expect(result.requestId).toBe('req_1');
  });

  it('classifies 401 and 403 as unauthorized, not retryable', async () => {
    for (const status of [401, 403]) {
      const result = await fetchWith(
        jsonResponse({ message: 'Invalid API key' }, { status, statusText: 'Unauthorized' })
      );
      expect(result.kind).toBe('unauthorized');
      expect(result.kind === 'unauthorized' && result.message).toContain('Invalid API key');
    }
  });

  it('classifies 429 and 5xx as retryable and surfaces Retry-After', async () => {
    const rateLimited = await fetchWith(
      jsonResponse(
        { message: 'Too many requests' },
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '12' } }
      )
    );
    expect(rateLimited.kind).toBe('retryable');
    expect(rateLimited.kind === 'retryable' && rateLimited.retryAfterMs).toBe(12_000);

    const serverError = await fetchWith(jsonResponse({ message: 'boom' }, { status: 503 }));
    expect(serverError.kind).toBe('retryable');
    expect(serverError.kind === 'retryable' && serverError.retryAfterMs).toBeNull();
  });

  it('classifies other 4xx as an invalid stream position', async () => {
    for (const status of [400, 422]) {
      const result = await fetchWith(
        jsonResponse({ message: 'Invalid value for after' }, { status })
      );
      expect(result.kind).toBe('invalid_position');
    }
  });

  it('falls back to the status when the error body is not JSON', async () => {
    const result = await fetchWith(
      new Response('<html>gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })
    );
    expect(result.kind).toBe('retryable');
    expect(result.kind === 'retryable' && result.message).toBe('HTTP 502');
  });
});
