import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import migrations from '../../drizzle/migrations';
import { getWorkOSEventSyncDOStub, type WorkOSEventSyncDO } from '../../src/dos/WorkOSEventSyncDO';
import { resolveSecret } from '../../src/util/secret';

type StubbedRequest = { url: string; authorization: string | null };

const originalFetch = globalThis.fetch;
let requests: StubbedRequest[] = [];

/** Serves the given responses in order, then repeats the final one. */
function stubWorkOS(responses: (() => Response)[]): void {
  let index = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, authorization: request.headers.get('authorization') });
    const factory = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(factory());
  }) as typeof fetch;
}

function eventsPage(ids: string[], after: string | null = null): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        object: 'list',
        data: ids.map((id, position) => ({
          object: 'event',
          id,
          event: 'dsync.user.created',
          created_at: `2026-11-02T10:00:${String(position).padStart(2, '0')}.000Z`,
          data: { id: `directory_user_${id}` },
        })),
        list_metadata: { after },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' } }
    );
}

function errorPage(status: number, body: unknown, headers: Record<string, string> = {}) {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

/** A full page of 100 synthetic event IDs, which signals "more may remain". */
function fullPageIds(prefix: string): string[] {
  return Array.from({ length: 100 }, (_, i) => `${prefix}_${String(i).padStart(3, '0')}`);
}

function stub() {
  return getWorkOSEventSyncDOStub(env);
}

/** Isolates each test: the namespace is a singleton by design. */
async function resetDO(): Promise<void> {
  await runInDurableObject(stub(), async (instance: WorkOSEventSyncDO, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
    // `deleteAll` wipes `__drizzle_migrations`, so the schema must be rebuilt.
    await migrate(drizzle(state.storage, { logger: false }), migrations);
    void instance;
  });
}

beforeEach(async () => {
  requests = [];
  await resetDO();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('WorkOSEventSyncDO', () => {
  it('enters the stream with range_start when it has no cursor, then advances by event id', async () => {
    stubWorkOS([eventsPage(['event_01', 'event_02'], 'event_02')]);

    const outcome = await stub().poll();

    expect(outcome.stopReason).toBe('drained');
    expect(outcome.eventsHandled).toBe(2);
    expect(outcome.cursor).toBe('event_02');

    const coldStartUrl = new URL(requests[0].url);
    expect(coldStartUrl.searchParams.has('range_start')).toBe(true);
    expect(coldStartUrl.searchParams.has('after')).toBe(false);
    expect(coldStartUrl.searchParams.get('limit')).toBe('100');
    // Derived from the binding, not a literal: a developer's `.dev.vars` key
    // overrides `wrangler.test.jsonc`'s var.
    expect(requests[0].authorization).toBe(`Bearer ${await resolveSecret(env.WORKOS_API_KEY)}`);

    const status = await stub().getStatus();
    expect(status.cursor).toBe('event_02');
    expect(status.eventsSeen).toBe(2);
    expect(status.lastEventCreatedAt).toBe('2026-11-02T10:00:01.000Z');
    expect(status.consecutiveFailures).toBe(0);
  });

  it('keeps the cursor when a later poll returns an empty page', async () => {
    stubWorkOS([eventsPage(['event_01'], 'event_01')]);
    await stub().poll();
    expect((await stub().getStatus()).cursor).toBe('event_01');

    // A caught-up stream answers with an empty page and `after: null`. Writing
    // that null back would rewind to the start of the 90-day retention window.
    requests = [];
    stubWorkOS([eventsPage([], null)]);
    const outcome = await stub().poll();

    expect(outcome.eventsHandled).toBe(0);
    expect(outcome.cursor).toBe('event_01');
    expect((await stub().getStatus()).cursor).toBe('event_01');
    expect(new URL(requests[0].url).searchParams.get('after')).toBe('event_01');
  });

  it('drains consecutive full pages within one tick and stops at the page budget', async () => {
    const first = fullPageIds('a');
    stubWorkOS([eventsPage(first, first.at(-1) ?? null)]);

    const outcome = await stub().poll();

    expect(outcome.pagesFetched).toBe(10);
    expect(outcome.eventsHandled).toBe(1000);
    expect(outcome.stopReason).toBe('page_budget');
    // Comes straight back instead of idling a full interval with a known backlog.
    expect(outcome.nextPollInMs).toBe(1_000);
    // Every page after the first is requested with the advanced cursor.
    expect(new URL(requests[1].url).searchParams.get('after')).toBe(first.at(-1));
  });

  it('holds the cursor and honors Retry-After on a 429', async () => {
    stubWorkOS([eventsPage(['event_01'], 'event_01')]);
    await stub().poll();

    stubWorkOS([errorPage(429, { message: 'Too many requests' }, { 'retry-after': '20' })]);
    const outcome = await stub().poll();

    expect(outcome.stopReason).toBe('retryable');
    expect(outcome.nextPollInMs).toBe(20_000);
    expect(outcome.cursor).toBe('event_01');

    const status = await stub().getStatus();
    expect(status.cursor).toBe('event_01');
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError).toContain('Too many requests');
  });

  it('drops a rejected cursor and re-enters the stream by range_start', async () => {
    stubWorkOS([eventsPage(['event_01'], 'event_01')]);
    await stub().poll();

    requests = [];
    stubWorkOS([errorPage(400, { message: 'Invalid value for after' })]);
    const outcome = await stub().poll();

    expect(outcome.stopReason).toBe('invalid_position');
    expect(outcome.cursor).toBeNull();
    expect((await stub().getStatus()).cursor).toBeNull();

    // The next poll must not retry the rejected cursor.
    requests = [];
    stubWorkOS([eventsPage(['event_09'], 'event_09')]);
    await stub().poll();
    const retryUrl = new URL(requests[0].url);
    expect(retryUrl.searchParams.has('after')).toBe(false);
    expect(retryUrl.searchParams.has('range_start')).toBe(true);
  });

  it('backs off hard on an unusable API key instead of hot-looping', async () => {
    stubWorkOS([errorPage(401, { message: 'Invalid API key' })]);

    const outcome = await stub().poll();

    expect(outcome.stopReason).toBe('unauthorized');
    expect(outcome.nextPollInMs).toBe(600_000);
    expect((await stub().getStatus()).lastError).toContain('Invalid API key');
  });

  it('preserves the cursor and the stream entry instant across a restart', async () => {
    stubWorkOS([eventsPage(['event_01'], 'event_01')]);
    await stub().poll();
    const before = await stub().getStatus();

    // Reconstructs the DO against the same storage, re-running the constructor
    // and its migration: state must come back from SQLite, not memory.
    await runInDurableObject(stub(), async (instance: WorkOSEventSyncDO) => {
      void instance;
    });
    const after = await stub().getStatus();

    expect(after.cursor).toBe('event_01');
    expect(after.rangeStart).toBe(before.rangeStart);
    expect(after.eventsSeen).toBe(1);
  });

  it('arms the alarm once and leaves a live alarm untouched', async () => {
    const first = await stub().ensureScheduled();
    expect(first.armed).toBe(true);

    const second = await stub().ensureScheduled();
    expect(second.armed).toBe(false);
    expect(second.nextAlarmAt).toBe(first.nextAlarmAt);
  });

  it('reschedules itself after an alarm fires', async () => {
    stubWorkOS([eventsPage([], null)]);

    await runInDurableObject(stub(), async (instance: WorkOSEventSyncDO, state) => {
      await instance.alarm();
      const next = await state.storage.getAlarm();
      expect(next).not.toBeNull();
      // Steady-state interval: 60s from the end of the tick.
      expect((next ?? 0) - Date.now()).toBeGreaterThan(50_000);
      expect((next ?? 0) - Date.now()).toBeLessThanOrEqual(60_000);
    });
  });

  it('stays scheduled when a tick throws instead of ending the poll chain', async () => {
    // Reproduces the failure a live `wrangler dev` run surfaced: an
    // unreachable upstream threw out of the alarm, no `setAlarm` ran, and the
    // stream froze once Cloudflare's bounded alarm retries were spent.
    globalThis.fetch = (() => Promise.reject(new Error('upstream unreachable'))) as typeof fetch;

    await runInDurableObject(stub(), async (instance: WorkOSEventSyncDO, state) => {
      await expect(instance.alarm()).resolves.toBeUndefined();
      const next = await state.storage.getAlarm();
      expect(next).not.toBeNull();
      expect((next ?? 0) - Date.now()).toBeGreaterThan(0);
    });

    const status = await stub().getStatus();
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError).toContain('upstream unreachable');
  });

  it('resets the cursor to an operator-supplied instant', async () => {
    stubWorkOS([eventsPage(['event_01'], 'event_01')]);
    await stub().poll();

    const status = await stub().resetCursor('2026-10-01T00:00:00.000Z');

    expect(status.cursor).toBeNull();
    expect(status.rangeStart).toBe('2026-10-01T00:00:00.000Z');
  });
});
