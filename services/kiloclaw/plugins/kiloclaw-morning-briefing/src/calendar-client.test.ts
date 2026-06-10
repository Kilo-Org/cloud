import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCalendarAccessToken,
  fetchCalendarEvents,
  resolveCalendarReady,
} from './calendar-client';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, OPENCLAW_GATEWAY_TOKEN: 'test-token' };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function mockFetch(impl: typeof fetch): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('resolveCalendarReady', () => {
  it('returns connected=false when the broker reports no connection', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ connected: false, accounts: [] }, 200));
    const result = await resolveCalendarReady({ fetchImpl });
    expect(result.statusOk).toBe(true);
    expect(result.connected).toBe(false);
    expect(result.accountEmail).toBeNull();
    expect(result.hasCalendarCapability).toBe(false);
    expect(result.reason).toBe('Google account not connected');
  });

  it('returns connected=true with hasCalendarCapability=true when services includes calendar_read', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse(
        {
          connected: true,
          accounts: [
            {
              email: 'astorms@kilocode.ai',
              client: 'kilo-oauth',
              services: ['calendar_read'],
              scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
              created_at: '2026-05-01T00:00:00Z',
              auth: 'oauth',
              profile: 'kilo_owned',
              status: 'active',
            },
          ],
        },
        200
      )
    );
    const result = await resolveCalendarReady({ fetchImpl });
    expect(result.statusOk).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.accountEmail).toBe('astorms@kilocode.ai');
    expect(result.hasCalendarCapability).toBe(true);
  });

  it('detects calendar scope when capability flag is absent', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse(
        {
          connected: true,
          accounts: [
            {
              email: 'astorms@kilocode.ai',
              client: 'kilo-legacy',
              services: ['gmail_read'],
              scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
              created_at: '2026-05-01T00:00:00Z',
              auth: 'oauth-legacy',
              profile: 'legacy',
              status: 'active',
            },
          ],
        },
        200
      )
    );
    const result = await resolveCalendarReady({ fetchImpl });
    expect(result.hasCalendarCapability).toBe(true);
  });

  it('returns hasCalendarCapability=false when neither services nor scopes mention calendar', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse(
        {
          connected: true,
          accounts: [
            {
              email: 'astorms@kilocode.ai',
              client: 'kilo-oauth',
              services: ['gmail_read'],
              scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
              created_at: '2026-05-01T00:00:00Z',
              auth: 'oauth',
              profile: 'kilo_owned',
              status: 'active',
            },
          ],
        },
        200
      )
    );
    const result = await resolveCalendarReady({ fetchImpl });
    expect(result.connected).toBe(true);
    expect(result.hasCalendarCapability).toBe(false);
    expect(result.reason).toContain('missing calendar scope');
  });

  it('returns a failure reason when the broker returns 5xx', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ error: 'boom' }, 503));
    const result = await resolveCalendarReady({ fetchImpl });
    expect(result.statusOk).toBe(false);
    expect(result.connected).toBe(false);
    expect(result.reason).toContain('(503)');
    expect(result.reason).toContain('boom');
  });
});

describe('fetchCalendarAccessToken', () => {
  it('returns accessToken + accountEmail on broker success', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse(
        {
          accessToken: 'ya29.fake',
          expiresAt: '2026-05-19T16:00:00Z',
          accountEmail: 'astorms@kilocode.ai',
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        },
        200
      )
    );
    const token = await fetchCalendarAccessToken({ fetchImpl });
    expect(token.accessToken).toBe('ya29.fake');
    expect(token.accountEmail).toBe('astorms@kilocode.ai');
  });

  it('throws a stable error code when the broker returns 5xx', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ error: 'broker_down' }, 502));
    await expect(fetchCalendarAccessToken({ fetchImpl })).rejects.toThrow(
      /google_oauth_token_fetch_failed:502/
    );
  });
});

describe('fetchCalendarEvents', () => {
  it('parses events from the Google API response', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse(
        {
          items: [
            {
              id: 'evt-1',
              summary: 'Standup',
              start: { dateTime: '2026-05-19T16:00:00Z' },
              end: { dateTime: '2026-05-19T16:30:00Z' },
            },
            {
              id: 'evt-2',
              summary: 'Offsite',
              start: { date: '2026-05-19' },
              end: { date: '2026-05-20' },
            },
          ],
        },
        200
      )
    );
    const events = await fetchCalendarEvents(
      'ya29.fake',
      '2026-05-19T00:00:00Z',
      '2026-05-20T12:00:00Z',
      { fetchImpl }
    );
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('evt-1');
    expect(events[1].id).toBe('evt-2');
  });

  it('returns an empty array when items is missing', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({}, 200));
    const events = await fetchCalendarEvents('ya29.fake', 'a', 'b', { fetchImpl });
    expect(events).toEqual([]);
  });

  it('throws with the Google error message on 401', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ error: { message: 'Invalid Credentials' } }, 401)
    );
    await expect(fetchCalendarEvents('ya29.fake', 'a', 'b', { fetchImpl })).rejects.toThrow(
      /google_calendar_fetch_failed:401:Invalid Credentials/
    );
  });
});
