import { z } from 'zod';

/**
 * WorkOS Directory Sync (SCIM) event types.
 *
 * The Events API requires the `events` filter, so this list is the poller's
 * subscription. There is no `directory.*` namespace: directory lifecycle is
 * `dsync.activated` / `dsync.deleted`.
 *
 * https://workos.com/docs/events
 */
export const DSYNC_EVENT_TYPES = [
  'dsync.activated',
  'dsync.deleted',
  'dsync.user.created',
  'dsync.user.updated',
  'dsync.user.deleted',
  'dsync.group.created',
  'dsync.group.updated',
  'dsync.group.deleted',
  'dsync.group.user_added',
  'dsync.group.user_removed',
] as const;

/**
 * Event payload shapes differ per type (`dsync.user.*` carries a Directory
 * User, `dsync.group.user_added` carries `{directory_id, user, group}`,
 * `dsync.activated` carries `domains[]`), so `data` stays an unmodelled record
 * for this iteration rather than a wrong flattened shape.
 *
 * https://workos.com/docs/reference/events/list
 */
export const WorkOSEventSchema = z.object({
  object: z.literal('event'),
  id: z.string(),
  event: z.string(),
  created_at: z.string(),
  data: z.record(z.string(), z.unknown()),
  context: z.record(z.string(), z.unknown()).nullish(),
});

export type WorkOSEvent = z.infer<typeof WorkOSEventSchema>;

export const WorkOSEventPageSchema = z.object({
  object: z.literal('list'),
  data: z.array(WorkOSEventSchema),
  // Null or absent at the end of the list. Never used to advance the cursor:
  // see `lastEventId`.
  list_metadata: z.object({ after: z.string().nullish() }).nullish(),
});

export type WorkOSEventPage = z.infer<typeof WorkOSEventPageSchema>;

/** WorkOS error envelope. The body is JSON for every documented failure. */
const WorkOSErrorSchema = z.object({
  message: z.string().nullish(),
  error: z.string().nullish(),
  error_description: z.string().nullish(),
  code: z.string().nullish(),
});

/** Maximum page size the Events API accepts. */
export const MAX_PAGE_LIMIT = 100;

export type FetchEventPageParams = {
  baseUrl: string;
  apiKey: string;
  limit: number;
  /**
   * Stream position. `after` is an event ID; `range_start` is an ISO-8601 UTC
   * instant used only to enter the stream. The API rejects both together, so
   * this is a union, not two optional fields.
   */
  position: { kind: 'after'; after: string } | { kind: 'range_start'; rangeStart: string };
  signal?: AbortSignal;
};

export type FetchEventPageResult =
  | { kind: 'page'; page: WorkOSEventPage; requestId: string | null }
  /** 4xx attributable to the stream position: the cursor must be dropped. */
  | { kind: 'invalid_position'; status: number; message: string; requestId: string | null }
  /** 401/403: the key is unusable. Retrying on a short interval is pointless. */
  | { kind: 'unauthorized'; status: number; message: string; requestId: string | null }
  /** 429 or 5xx: retry later with the same cursor. */
  | {
      kind: 'retryable';
      status: number;
      message: string;
      retryAfterMs: number | null;
      requestId: string | null;
    };

export function buildEventsUrl(params: Omit<FetchEventPageParams, 'apiKey' | 'signal'>): string {
  const url = new URL('/events', params.baseUrl);
  for (const eventType of DSYNC_EVENT_TYPES) {
    url.searchParams.append('events', eventType);
  }
  url.searchParams.set('limit', String(params.limit));
  if (params.position.kind === 'after') {
    url.searchParams.set('after', params.position.after);
  } else {
    url.searchParams.set('range_start', params.position.rangeStart);
  }
  return url.toString();
}

/**
 * `Retry-After` is either delay-seconds or an HTTP date.
 * Returns null when the header is absent or unparseable.
 */
export function parseRetryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - now);
}

/**
 * The cursor for the next request. Taken from the last element of `data`, per
 * WorkOS's guidance to pass "the ID of the latest processed event".
 *
 * Deliberately NOT `list_metadata.after`: that field is null on an empty or
 * final page, and writing a null back over a live cursor would rewind the
 * poller to the start of the 90-day retention window on the next tick.
 */
export function lastEventId(page: WorkOSEventPage): string | null {
  const last = page.data.at(-1);
  return last?.id ?? null;
}

async function describeFailure(
  response: Response
): Promise<{ message: string; requestId: string | null }> {
  const requestId = response.headers.get('x-request-id');
  let message = `HTTP ${response.status}`;
  try {
    const parsed = WorkOSErrorSchema.safeParse(await response.json());
    if (parsed.success) {
      const detail =
        parsed.data.message ?? parsed.data.error_description ?? parsed.data.error ?? null;
      if (detail !== null) message = `HTTP ${response.status}: ${detail}`;
    }
  } catch {
    // Non-JSON body (gateway error page). The status alone is the message.
  }
  return { message, requestId };
}

/**
 * Fetches one page of WorkOS events.
 *
 * Uses `fetch` rather than `@workos-inc/node` on purpose: the SDK deserializes
 * into camelCase classes (so a Zod schema would validate an already-reshaped
 * value, against this repo's IO-boundary rule) and retries internally 3x, which
 * would nest inside the caller's own retry and backoff.
 */
export async function fetchEventPage(params: FetchEventPageParams): Promise<FetchEventPageResult> {
  const response = await fetch(buildEventsUrl(params), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      Accept: 'application/json',
    },
    signal: params.signal,
  });

  if (response.ok) {
    const page = WorkOSEventPageSchema.parse(await response.json());
    return { kind: 'page', page, requestId: response.headers.get('x-request-id') };
  }

  const { message, requestId } = await describeFailure(response);

  if (response.status === 401 || response.status === 403) {
    return { kind: 'unauthorized', status: response.status, message, requestId };
  }

  if (response.status === 429 || response.status >= 500) {
    return {
      kind: 'retryable',
      status: response.status,
      message,
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), Date.now()),
      requestId,
    };
  }

  // Any other 4xx on a request whose only variable input is the cursor is a
  // rejected cursor (400/422 for a malformed or expired event ID). Retrying it
  // can never succeed, so the caller must re-enter the stream instead.
  return { kind: 'invalid_position', status: response.status, message, requestId };
}
