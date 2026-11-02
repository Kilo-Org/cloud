import { DurableObject } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import migrations from '../../drizzle/migrations';
import { pollState, type PollStateRow } from '../db/sqlite-schema';
import { logger } from '../util/logger';
import { resolveSecret } from '../util/secret';
import { fetchEventPage, lastEventId, MAX_PAGE_LIMIT, type WorkOSEvent } from '../workos/events';

/**
 * The WorkOS Events API is environment-scoped and WorkOS prescribes a single
 * serial consumer, so this namespace holds exactly one instance.
 */
export const WORKOS_EVENT_SYNC_DO_NAME = 'workos-events';

/** Pinned primary key of the single `poll_state` row. */
const SINGLETON_POLL_STATE_ID = 1;

/** Steady-state interval between polls. */
const POLL_INTERVAL_MS = 60_000;

/** Pages drained per alarm, bounding one tick's wall time and request budget. */
const MAX_PAGES_PER_TICK = 10;

/** Backoff floor/ceiling for failed polls. */
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * An unusable API key cannot recover without an operator, so retrying it on the
 * steady-state interval only burns quota and floods logs.
 */
const UNAUTHORIZED_BACKOFF_MS = 10 * 60_000;

export type SyncStatus = {
  cursor: string | null;
  lastEventCreatedAt: string | null;
  rangeStart: string | null;
  lastPolledAt: number | null;
  lastEventAt: number | null;
  eventsSeen: number;
  consecutiveFailures: number;
  lastError: string | null;
  nextAlarmAt: number | null;
};

/** Outcome of one alarm tick. Returned for tests and the `/status` endpoint. */
export type PollOutcome = {
  pagesFetched: number;
  eventsHandled: number;
  cursor: string | null;
  stopReason: 'drained' | 'page_budget' | 'unauthorized' | 'invalid_position' | 'retryable';
  nextPollInMs: number;
};

export class WorkOSEventSyncDO extends DurableObject<Env> {
  private readonly db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  /**
   * Arms the poll loop if it is not already armed. Idempotent: called on every
   * cron tick as a watchdog, so it must never disturb a live alarm.
   */
  async ensureScheduled(): Promise<{ armed: boolean; nextAlarmAt: number }> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) {
      return { armed: false, nextAlarmAt: existing };
    }

    await this.loadOrCreateState();
    const nextAlarmAt = Date.now() + 1_000;
    await this.ctx.storage.setAlarm(nextAlarmAt);
    logger.info('WorkOS event sync armed', { nextAlarmAt });
    return { armed: true, nextAlarmAt };
  }

  async getStatus(): Promise<SyncStatus> {
    const state = await this.loadOrCreateState();
    return {
      cursor: state.cursor,
      lastEventCreatedAt: state.last_event_created_at,
      rangeStart: state.range_start,
      lastPolledAt: state.last_polled_at,
      lastEventAt: state.last_event_at,
      eventsSeen: state.events_seen,
      consecutiveFailures: state.consecutive_failures,
      lastError: state.last_error,
      nextAlarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  /**
   * Drops the cursor and re-enters the stream at `rangeStart` (defaults to now).
   * Used by the invalid-cursor recovery path and for manual operator recovery.
   */
  async resetCursor(rangeStart?: string): Promise<SyncStatus> {
    const enteredAt = rangeStart ?? new Date().toISOString();
    await this.loadOrCreateState();
    this.db
      .update(pollState)
      .set({ cursor: null, range_start: enteredAt, updated_at: unixNow() })
      .where(eq(pollState.id, SINGLETON_POLL_STATE_ID))
      .run();
    logger.warn('WorkOS event sync cursor reset', { rangeStart: enteredAt });
    return this.getStatus();
  }

  override async alarm(): Promise<void> {
    // An unexpected throw inside `poll` (an unreachable Secrets Store, a
    // response shape Zod rejects) must not end the poll chain: Cloudflare
    // retries a failed alarm a bounded number of times and then stops, which
    // would silently freeze the stream until the next cron watchdog tick.
    // Catching here keeps the loop alive on a backoff instead.
    let nextPollInMs = POLL_INTERVAL_MS;
    try {
      nextPollInMs = (await this.poll()).nextPollInMs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failures = this.recordFailure(message);
      nextPollInMs = backoffMs(failures);
      logger.error('WorkOS event sync tick threw; staying scheduled', {
        error: message,
        consecutiveFailures: failures,
        nextPollInMs,
      });
    }
    await this.ctx.storage.setAlarm(Date.now() + nextPollInMs);
  }

  /**
   * One poll tick: drains up to `MAX_PAGES_PER_TICK` pages, logging every event
   * and committing the cursor after each page so a mid-tick failure never
   * replays work that was already logged.
   *
   * Exposed as an RPC method so a smoke run and the integration tests can drive
   * a single tick without waiting on the alarm.
   */
  async poll(): Promise<PollOutcome> {
    const state = await this.loadOrCreateState();
    const apiKey = await resolveSecret(this.env.WORKOS_API_KEY);
    const baseUrl = this.env.WORKOS_API_BASE_URL;

    let cursor = state.cursor;
    let rangeStart = state.range_start ?? new Date().toISOString();
    let pagesFetched = 0;
    let eventsHandled = 0;

    // The entry instant is persisted before the first request so a crash
    // mid-tick cannot slide the window forward and skip events.
    if (state.range_start === null) {
      this.db
        .update(pollState)
        .set({ range_start: rangeStart, updated_at: unixNow() })
        .where(eq(pollState.id, SINGLETON_POLL_STATE_ID))
        .run();
    }

    for (; pagesFetched < MAX_PAGES_PER_TICK;) {
      const result = await fetchEventPage({
        baseUrl,
        apiKey,
        limit: MAX_PAGE_LIMIT,
        position:
          cursor === null ? { kind: 'range_start', rangeStart } : { kind: 'after', after: cursor },
      });
      pagesFetched += 1;

      if (result.kind === 'unauthorized') {
        this.recordFailure(result.message);
        logger.error('WorkOS events request rejected the API key', {
          status: result.status,
          error: result.message,
          requestId: result.requestId,
        });
        return {
          pagesFetched,
          eventsHandled,
          cursor,
          stopReason: 'unauthorized',
          nextPollInMs: UNAUTHORIZED_BACKOFF_MS,
        };
      }

      if (result.kind === 'invalid_position') {
        // A rejected cursor can never succeed on retry, so re-enter the stream
        // instead of backing off against the same bad value.
        this.recordFailure(result.message);
        logger.error('WorkOS events rejected the stream position; re-entering stream', {
          status: result.status,
          error: result.message,
          requestId: result.requestId,
          hadCursor: cursor !== null,
        });
        rangeStart = new Date().toISOString();
        cursor = null;
        this.db
          .update(pollState)
          .set({ cursor: null, range_start: rangeStart, updated_at: unixNow() })
          .where(eq(pollState.id, SINGLETON_POLL_STATE_ID))
          .run();
        return {
          pagesFetched,
          eventsHandled,
          cursor,
          stopReason: 'invalid_position',
          nextPollInMs: POLL_INTERVAL_MS,
        };
      }

      if (result.kind === 'retryable') {
        const failures = this.recordFailure(result.message);
        logger.warn('WorkOS events request failed; retrying with the same cursor', {
          status: result.status,
          error: result.message,
          requestId: result.requestId,
          consecutiveFailures: failures,
        });
        return {
          pagesFetched,
          eventsHandled,
          cursor,
          stopReason: 'retryable',
          nextPollInMs: result.retryAfterMs ?? backoffMs(failures),
        };
      }

      const events = result.page.data;
      for (const event of events) {
        logEvent(event, result.requestId);
      }
      eventsHandled += events.length;

      // Advance from the last event in `data`, never from
      // `list_metadata.after`: that is null on an empty or final page and would
      // rewind the stream to the start of retention.
      const nextCursor = lastEventId(result.page);
      if (nextCursor !== null) {
        cursor = nextCursor;
        this.commitProgress({
          cursor: nextCursor,
          lastEventCreatedAt: events.at(-1)?.created_at ?? null,
          newEvents: events.length,
          eventsSeen: state.events_seen + eventsHandled,
        });
      }

      // A short page means the stream is drained; only a full page can have more.
      if (events.length < MAX_PAGE_LIMIT) {
        this.clearFailure();
        logger.info('WorkOS event sync caught up', {
          pagesFetched,
          eventsHandled,
          cursor,
        });
        return {
          pagesFetched,
          eventsHandled,
          cursor,
          stopReason: 'drained',
          nextPollInMs: POLL_INTERVAL_MS,
        };
      }
    }

    // Backlog remains and the page budget is spent. Come back immediately
    // rather than idling a full interval with known pending work.
    this.clearFailure();
    logger.info('WorkOS event sync hit its page budget with a backlog remaining', {
      pagesFetched,
      eventsHandled,
      cursor,
    });
    return {
      pagesFetched,
      eventsHandled,
      cursor,
      stopReason: 'page_budget',
      nextPollInMs: 1_000,
    };
  }

  private async loadOrCreateState(): Promise<PollStateRow> {
    const existing = this.db
      .select()
      .from(pollState)
      .where(eq(pollState.id, SINGLETON_POLL_STATE_ID))
      .all();
    const found = existing.at(0);
    if (found !== undefined) return found;

    return this.db
      .insert(pollState)
      .values({ id: SINGLETON_POLL_STATE_ID, updated_at: unixNow() })
      .returning()
      .all()[0];
  }

  private commitProgress(progress: {
    cursor: string;
    lastEventCreatedAt: string | null;
    newEvents: number;
    eventsSeen: number;
  }): void {
    const now = unixNow();
    this.db
      .update(pollState)
      .set({
        cursor: progress.cursor,
        last_event_created_at: progress.lastEventCreatedAt,
        last_polled_at: now,
        last_event_at: progress.newEvents > 0 ? now : undefined,
        events_seen: progress.eventsSeen,
        consecutive_failures: 0,
        last_error: null,
        updated_at: now,
      })
      .where(eq(pollState.id, SINGLETON_POLL_STATE_ID))
      .run();
  }

  private clearFailure(): void {
    const now = unixNow();
    this.db
      .update(pollState)
      .set({ last_polled_at: now, consecutive_failures: 0, last_error: null, updated_at: now })
      .where(eq(pollState.id, SINGLETON_POLL_STATE_ID))
      .run();
  }

  /** Records a failed poll and returns the new consecutive-failure count. */
  private recordFailure(message: string): number {
    const now = unixNow();
    const updated = this.db
      .update(pollState)
      .set({
        last_polled_at: now,
        consecutive_failures: sql`${pollState.consecutive_failures} + 1`,
        last_error: message,
        updated_at: now,
      })
      .where(eq(pollState.id, SINGLETON_POLL_STATE_ID))
      .returning({ consecutiveFailures: pollState.consecutive_failures })
      .all();
    return updated.at(0)?.consecutiveFailures ?? 1;
  }
}

/**
 * Jittered exponential backoff. Jitter keeps a restarted fleet from
 * resynchronizing onto the same retry instant.
 */
export function backoffMs(consecutiveFailures: number): number {
  const exponential = MIN_BACKOFF_MS * 2 ** Math.max(0, consecutiveFailures - 1);
  const capped = Math.min(exponential, MAX_BACKOFF_MS);
  return capped + Math.floor(Math.random() * 1_000);
}

/**
 * Logs one event. Only envelope fields are logged: `data` carries directory
 * user attributes (emails, names, raw IdP attributes) that must not land in
 * Workers Logs.
 */
function logEvent(event: WorkOSEvent, requestId: string | null): void {
  logger.info('WorkOS directory event', {
    eventId: event.id,
    eventType: event.event,
    eventCreatedAt: event.created_at,
    dataKeys: Object.keys(event.data).sort(),
    requestId,
  });
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export function getWorkOSEventSyncDOStub(env: Env): DurableObjectStub<WorkOSEventSyncDO> {
  return env.WORKOS_EVENT_SYNC_DO.getByName(WORKOS_EVENT_SYNC_DO_NAME);
}
