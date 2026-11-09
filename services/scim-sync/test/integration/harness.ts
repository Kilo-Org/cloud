import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { vi } from 'vitest';

import { eventFailures, parkedEvents, syncState } from '../../src/db/sqlite-schema';
import type { ScimSyncDO } from '../../src/dos/ScimSyncDO';

/**
 * One stub per test name, so tests do not share a cursor. `reset()` in the
 * setup file clears the storage between them regardless.
 */
export function stub(name: string): DurableObjectStub<ScimSyncDO> {
  return env.SCIM_SYNC_DO.getByName(name);
}

export type RecordedCall = {
  method: string;
  /** Path only: the origin is fixed by `BACKEND_API_URL`. */
  path: string;
  body: unknown;
  apiKey: string | null;
  /**
   * `x-vercel-protection-bypass`, or null when the call omitted it. Staging's
   * origin sits behind Vercel Deployment Protection and production's does
   * not, so whether this header is present is itself behaviour.
   */
  protectionBypass: string | null;
  /**
   * The redirect mode the caller asked for; `'follow'` when it asked for
   * nothing, which is the platform default. Recorded because following a
   * redirect would hand `x-internal-api-key` to the redirect's origin.
   * Typed as the runtime types type it on `RequestInit`.
   */
  redirect: string;
};

/** What the stubbed app answers for one request, in the order configured. */
export type AppReply =
  | { status: 200; body: unknown }
  | { status: 409; code: string; error?: string }
  /**
   * A redirect, served the way the platform would: followed to `location`
   * when the caller allows it, returned as the 3xx itself when the caller
   * asked for `manual`, and raised when it asked for `error`.
   */
  | { status: 301 | 302 | 303 | 307 | 308; location: string; body: unknown }
  | { status: number; body?: unknown }
  | { throws: string };

export type AppRoute = {
  method: string;
  /** Matched by suffix, so `/memberships` matches the revoke-all route too. */
  path: string;
  replies: AppReply[];
};

const UPSERT_OK = { status: 200 as const, body: { id: 'org_1', created: false } };

/**
 * Default 200 bodies, one per route, so a test only configures the responses it
 * is actually asserting on. Each matches the schema the dispatcher parses.
 */
export function defaultReply(method: string, path: string): AppReply {
  if (path.endsWith('/memberships') && path.includes('/users/')) {
    return { status: 200, body: { kiloUserId: 'user_1', revokedOrganizationIds: ['org_1'] } };
  }
  if (path.endsWith('/memberships')) {
    return method === 'DELETE'
      ? {
          status: 200,
          body: {
            organizationId: 'org_2',
            parentOrganizationId: 'org_1',
            kiloUserId: 'user_1',
            removed: true,
            revokedParentMembership: false,
          },
        }
      : {
          status: 200,
          body: {
            organizationId: 'org_2',
            parentOrganizationId: 'org_1',
            kiloUserId: 'user_1',
            created: true,
            clearedRemovalTombstone: false,
          },
        };
  }
  if (method === 'DELETE') return { status: 200, body: { id: 'org_1', deleted: true } };
  return UPSERT_OK;
}

export type Harness = {
  /** Every call the dispatcher made to the app, in order. */
  calls: RecordedCall[];
  /** Every `after` cursor the Events API was asked for, in order. */
  cursors: (string | null)[];
};

/**
 * Stubs the WorkOS Events API and the app origin at the `fetch` boundary, by
 * replacing the global for the rest of the test.
 *
 * The global is the single boundary: both the SDK's HTTP client and
 * `dispatch/` call it, and the SDK's own `fetchFn` option is unusable because
 * its `workerd` build constructs the client without forwarding it. The two
 * origins are told apart by hostname, so an assertion still names which one it
 * means. `vi.stubGlobal` is restored by `unstubAllGlobals` in the setup file.
 *
 * `pages` are served in order and in the Events API's snake_case wire format,
 * because the SDK deserializes the response. Once they run out, every further
 * request answers an empty page, which is what stops the drain loop.
 */
export function harness(options: {
  pages: unknown[][];
  routes?: AppRoute[];
  /** Called with each recorded app call, before the reply is chosen. */
  onCall?: (call: RecordedCall) => void;
}): Harness {
  const calls: RecordedCall[] = [];
  const cursors: (string | null)[] = [];
  let pageIndex = 0;
  const routes = options.routes ?? [];
  const consumed = new Map<AppRoute, number>();

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';

    if (url.hostname === 'api.workos.com') {
      cursors.push(url.searchParams.get('after'));
      const page = options.pages[pageIndex] ?? [];
      pageIndex += 1;
      return Response.json({
        object: 'list',
        data: page,
        list_metadata: { before: null, after: null },
      });
    }

    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const headers = new Headers(init?.headers);
    const redirect = init?.redirect ?? 'follow';
    const call: RecordedCall = {
      method,
      path: url.pathname,
      body,
      apiKey: headers.get('x-internal-api-key'),
      protectionBypass: headers.get('x-vercel-protection-bypass'),
      redirect,
    };
    calls.push(call);
    options.onCall?.(call);

    const route = routes.find(r => r.method === method && url.pathname.endsWith(r.path));
    const reply =
      route === undefined
        ? defaultReply(method, url.pathname)
        : (route.replies[Math.min(consumed.get(route) ?? 0, route.replies.length - 1)] ??
          defaultReply(method, url.pathname));
    if (route !== undefined) consumed.set(route, (consumed.get(route) ?? 0) + 1);

    if ('throws' in reply) throw new Error(reply.throws);
    if ('location' in reply) {
      // The three modes the platform offers, so a test can assert which one
      // the caller asked for by what it gets back.
      if (redirect === 'error') throw new TypeError(`fetch to ${url.pathname} was redirected`);
      if (redirect === 'manual') {
        return Response.json(null, {
          status: reply.status,
          headers: { location: reply.location },
        });
      }
      // `follow`: the platform re-issues the request against `location`,
      // custom headers and all, and the caller parses whatever answers. The
      // re-issued request is recorded against the target's path, which is how
      // a test sees the internal secret cross an origin.
      const followed = new URL(reply.location);
      calls.push({
        method,
        path: `${followed.host}${followed.pathname}`,
        body,
        apiKey: headers.get('x-internal-api-key'),
        protectionBypass: headers.get('x-vercel-protection-bypass'),
        redirect,
      });
      return Response.json(reply.body);
    }
    if (reply.status === 409 && 'code' in reply) {
      return Response.json({ error: reply.error ?? 'conflict', code: reply.code }, { status: 409 });
    }
    if (reply.status === 200 && 'body' in reply) return Response.json(reply.body);
    return Response.json(
      'body' in reply && reply.body !== undefined ? reply.body : { error: 'failed' },
      { status: reply.status }
    );
  }) as typeof fetch;

  vi.stubGlobal('fetch', fetchFn);
  return { calls, cursors };
}

/**
 * The committed cursor and seed, read straight from the DO's SQLite, with the
 * held failure row: its attempt count is what an operator reset is supposed to
 * reset, so a test has to see it rather than just count rows.
 */
export async function readState(target: DurableObjectStub<ScimSyncDO>): Promise<{
  rows: Record<string, string>;
  failures: number;
  failure: { eventId: string; attempts: number } | null;
  parked: string[];
}> {
  return runInDurableObject(target, (_instance, state) => {
    const db = drizzle(state.storage);
    const rows: Record<string, string> = {};
    for (const row of db.select().from(syncState).all()) rows[row.key] = row.value;
    const failureRows = db.select().from(eventFailures).all();
    const held = failureRows[0];
    return {
      rows,
      failures: failureRows.length,
      failure: held === undefined ? null : { eventId: held.event_id, attempts: held.attempts },
      parked: db
        .select()
        .from(parkedEvents)
        .all()
        .map(row => row.event_id),
    };
  });
}

/**
 * A `Date.now()` the test drives, so a 20-second drain budget or an hour's
 * conflict budget can be spent without the test waiting for it. `advance` is
 * wired to `harness`'s `onCall` hook, which makes one app request cost
 * `stepMs` — the shape of the real thing, where every call is bounded by
 * `REQUEST_TIMEOUT_MS`; `advanceBy` jumps the clock between polls. An
 * injected clock rather than a production seam: the loop reads the same
 * `Date.now()` it reads in production. Restored by `restoreAllMocks` in the
 * setup file.
 */
export function steppingClock(stepMs: number): {
  advance: () => void;
  advanceBy: (ms: number) => void;
} {
  const base = Date.now();
  let offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => base + offset);
  return {
    advance: () => {
      offset += stepMs;
    },
    advanceBy: (ms: number) => {
      offset += ms;
    },
  };
}

/** Events API wire format. Only the fields the dispatcher reads are filled. */
export function directoryEvent(
  id: string,
  organizationId: string | null = 'org_workos',
  event = 'dsync.activated'
): unknown {
  return {
    id,
    event,
    created_at: '2026-01-01T00:00:00.000Z',
    data: {
      object: 'directory',
      id: 'directory_01',
      external_key: 'key',
      type: 'okta scim v2.0',
      state: 'active',
      name: 'Acme',
      ...(organizationId === null ? {} : { organization_id: organizationId }),
      domains: [{ object: 'organization_domain', id: 'od_1', domain: 'acme.test' }],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

/**
 * An activation the SDK deserializes with `domains` absent, which is what the
 * Events API sends for a directory with none: the SDK copies the field through
 * without defaulting it, so the dispatcher's `data.domains.map(...)` throws a
 * `TypeError` rather than failing a schema check.
 */
export function activationWithoutDomains(id: string): unknown {
  const event = directoryEvent(id) as { data: Record<string, unknown> };
  const { domains: _dropped, ...data } = event.data;
  return { ...event, data };
}

export function groupEvent(id: string, event = 'dsync.group.created'): unknown {
  return {
    id,
    event,
    created_at: '2026-01-01T00:00:00.000Z',
    data: {
      id: 'dir_grp_01',
      idp_id: 'idp_grp_01',
      directory_id: 'directory_01',
      organization_id: null,
      name: 'Engineering',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      raw_attributes: {},
    },
  };
}

export function userEvent(
  id: string,
  event: string,
  overrides: { state?: 'active' | 'inactive'; email?: string | null } = {}
): unknown {
  return {
    id,
    event,
    created_at: '2026-01-01T00:00:00.000Z',
    data: directoryUserPayload(overrides),
  };
}

export function membershipEvent(id: string, event: string): unknown {
  return {
    id,
    event,
    created_at: '2026-01-01T00:00:00.000Z',
    data: {
      directory_id: 'directory_01',
      user: directoryUserPayload({}),
      group: {
        id: 'dir_grp_01',
        idp_id: 'idp_grp_01',
        directory_id: 'directory_01',
        organization_id: null,
        name: 'Engineering',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        raw_attributes: {},
      },
    },
  };
}

function directoryUserPayload(overrides: {
  state?: 'active' | 'inactive';
  email?: string | null;
}): unknown {
  return {
    object: 'directory_user',
    id: 'dir_usr_01',
    directory_id: 'directory_01',
    organization_id: null,
    raw_attributes: {},
    custom_attributes: {},
    idp_id: 'idp_usr_01',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: overrides.email === undefined ? 'ada@acme.test' : overrides.email,
    state: overrides.state ?? 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}
