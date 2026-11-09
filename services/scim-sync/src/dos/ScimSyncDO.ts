import { DurableObject } from 'cloudflare:workers';
import { WorkOS } from '@workos-inc/node';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import migrations from '../../drizzle/migrations';
import * as state from '../db/state';
import { applyEvent } from '../dispatch/apply-event';
import type { AppCallContext, AttemptOutcome } from '../dispatch/app-client';
import type { EventFailureState, PollResult, ScimSyncDOStatus } from '../types';
import {
  CATCH_UP_DELAY_SECONDS,
  CONFLICT_RETRY_BUDGET_MS,
  DRAIN_BUDGET_MS,
  DSYNC_EVENTS,
  LAST_POLL_KEY,
  MAX_RETRY_DELAY_SECONDS,
  PAGE_LIMIT,
  SCIM_SYNC_DO_NAME,
} from '../util/constants';
import { clampPollIntervalSeconds } from '../util/interval';
import { logger } from '../util/logger';
import { resolveSecret } from '../util/secret';

export class ScimSyncDO extends DurableObject<Env> {
  private db: state.Db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  /**
   * Arms the poll loop unless it is already armed. Idempotent, because the cron
   * watchdog calls it every five minutes and must never disturb a live alarm.
   */
  async ensureScheduled(): Promise<{ armed: boolean; nextAlarmAt: number }> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== null) {
      return { armed: false, nextAlarmAt: existing };
    }

    const nextAlarmAt = Date.now() + 1_000;
    await this.ctx.storage.setAlarm(nextAlarmAt);
    logger.info('SCIM sync poll armed', { nextAlarmAt });
    return { armed: true, nextAlarmAt };
  }

  async getStatus(): Promise<ScimSyncDOStatus> {
    const { cursor, source } = state.peekCursor(this.db, this.configuredCursor());
    return {
      instance: SCIM_SYNC_DO_NAME,
      environment: this.env.ENVIRONMENT,
      pollIntervalSeconds: clampPollIntervalSeconds(this.env.SCIM_POLL_INTERVAL_SECONDS),
      cursor,
      cursorSource: source,
      eventFailure: state.currentFailure(this.db),
      parkedCount: state.parkedCount(this.db),
      nextAlarmAt: await this.ctx.storage.getAlarm(),
      lastPoll: (await this.ctx.storage.get<PollResult>(LAST_POLL_KEY)) ?? null,
    };
  }

  override async alarm(): Promise<void> {
    // `poll` reports failures rather than throwing, so the chain survives a
    // WorkOS outage: Cloudflare retries a failed alarm a bounded number of
    // times and then stops, which would strand the loop until the next cron.
    // Persisted rather than held in a field: the object hibernates between
    // ticks, which discards in-memory state, and a `/status` read right after
    // a successful poll would then report nothing.
    const result = await this.poll();
    await this.ctx.storage.put(LAST_POLL_KEY, result);
    await this.ctx.storage.setAlarm(Date.now() + this.nextDelaySeconds(result) * 1000);
  }

  /**
   * Drains the event stream: fetches pages while the previous one came back
   * full and the wall-clock budget remains, applying each event serially and
   * committing the cursor per event. Exposed as an RPC so a single drain can be
   * driven without waiting for the alarm.
   *
   * Draining rather than one page per interval is what makes an initial sync
   * tractable: a real directory's first sync is tens of thousands of events,
   * which at one page an interval would take days.
   *
   * Both origins — the Events API through the SDK and the app through
   * `dispatch/` — are reached with the global `fetch`, which is the single
   * boundary a test stubs. The SDK's `fetchFn` option is not usable: its
   * `workerd` build constructs the HTTP client without forwarding it.
   */
  async poll(): Promise<PollResult> {
    const at = new Date().toISOString();
    const seed = this.configuredCursor();
    // Resolved before the `try` so the failure path can report the source, but
    // nothing outside the guard may throw past this method's promise to report
    // failures rather than raise them.
    let cursor: string | null = null;
    let cursorSource: PollResult['cursorSource'] = 'none';
    let eventCount = 0;
    let eventsApplied = 0;
    let eventsParked = 0;
    let lastEventId: string | null = null;
    let heldFailure: EventFailureState | null = null;
    // Nothing fetched yet, so nothing says the stream is caught up.
    let caughtUp = false;
    // Set when the drain budget ran out mid-page, which is not the stream
    // saying it is caught up: the page it stopped in still has events in it.
    let budgetSpent = false;

    try {
      const resolved = state.resolveCursor(this.db, seed);
      cursor = resolved.cursor;
      cursorSource = resolved.source;

      const workos = new WorkOS(await resolveSecret(this.env.WORKOS_API_KEY, 'WORKOS_API_KEY'), {
        clientId: await resolveSecret(this.env.WORKOS_CLIENT_ID, 'WORKOS_CLIENT_ID'),
        // The SDK retries 4xx-adjacent and 5xx responses internally. Leaving
        // that on would stretch a single alarm across several attempts and hide
        // the failure; the alarm interval is the retry.
        maxRetries: 0,
      });
      const app: AppCallContext = {
        origin: this.env.BACKEND_API_URL,
        apiKey: await resolveSecret(this.env.INTERNAL_API_SECRET, 'INTERNAL_API_SECRET'),
      };

      const deadline = Date.now() + DRAIN_BUDGET_MS;

      // `caughtUp` doubles as the loop condition: a short page is the stream
      // saying there is nothing more to read, which is also what decides
      // whether the next alarm is a second away or an interval away.
      while (!caughtUp && !budgetSpent && Date.now() < deadline && heldFailure === null) {
        const page = await workos.events.listEvents({
          events: DSYNC_EVENTS,
          limit: PAGE_LIMIT,
          ...(cursor === null ? {} : { after: cursor }),
        });
        caughtUp = page.data.length < PAGE_LIMIT;
        eventCount += page.data.length;

        for (const event of page.data) {
          // Per event, not only per page: a page is up to `PAGE_LIMIT` events
          // and one `dsync.group.user_added` issues three sequential calls,
          // each bounded by `REQUEST_TIMEOUT_MS`, so checking only in the
          // outer `while` lets one page run minutes past the budget the alarm
          // schedule is built on. Stopping here leaves the cursor where the
          // last applied event put it, and the next alarm resumes from there.
          if (Date.now() >= deadline) {
            budgetSpent = true;
            // Not caught up, whatever this page's length said: it still has
            // unapplied events in it, so the next alarm is the one-second
            // re-arm rather than the idle interval.
            caughtUp = false;
            break;
          }

          lastEventId = event.id;
          const outcome = await applyEvent(app, event);

          if (outcome.class === 'applied') {
            state.commitCursor(this.db, event.id, seed);
            state.clearFailure(this.db, event.id);
            cursor = event.id;
            eventsApplied += 1;
            continue;
          }

          const now = Date.now();
          const failure = state.recordFailure(this.db, event, outcome, now);

          if (this.shouldPark(outcome, failure, now)) {
            // Parking advances the cursor past the event, which is the whole
            // point: the stream continues, and the event stays recoverable in
            // `parked_events` rather than being silently lost.
            state.parkEvent(this.db, event, outcome, failure.attempts, now);
            state.commitCursor(this.db, event.id, seed);
            cursor = event.id;
            eventsParked += 1;
            logger.error('SCIM sync parked an event', {
              eventId: event.id,
              eventType: event.event,
              class: outcome.class,
              status: outcome.status,
              code: outcome.code,
              reason: outcome.reason,
              attempts: failure.attempts,
            });
            continue;
          }

          // Held: stop the page here, leave the cursor where it is, and let
          // the backoff re-arm. Events behind this one wait, which is what
          // "never advance past an event that could not be applied" means.
          heldFailure = failure;
          logger.warn('SCIM sync held the cursor on a failed event', {
            eventId: event.id,
            eventType: event.event,
            class: outcome.class,
            status: outcome.status,
            code: outcome.code,
            reason: outcome.reason,
            attempts: failure.attempts,
          });
          break;
        }
      }

      logger.info('SCIM sync poll complete', {
        eventCount,
        eventsApplied,
        eventsParked,
        cursor,
        cursorSource,
        lastEventId,
        caughtUp,
        held: heldFailure !== null,
      });

      return {
        at,
        eventCount,
        eventsApplied,
        eventsParked,
        lastEventId,
        cursor,
        cursorSource,
        caughtUp,
        heldFailure,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('SCIM sync poll failed', { error: message, cursor, cursorSource });
      return {
        at,
        eventCount,
        eventsApplied,
        eventsParked,
        lastEventId,
        cursor,
        cursorSource,
        caughtUp,
        heldFailure,
        error: message,
      };
    }
  }

  /**
   * Whether a failed event is stepped over rather than retried.
   *
   * `terminal` parks at once: no arrival order and no waiting repairs a
   * structural violation or a claim the directory cannot substantiate.
   * `conflict` parks only once its one-hour budget from the first failure is
   * spent — a conflict names a dependency an event *behind* the cursor can
   * supply, and nothing ahead of it ever will. `unavailable` never parks: the
   * app not answering says nothing about the event, and parking the stream
   * over a missing secret would discard every event behind it.
   */
  private shouldPark(outcome: AttemptOutcome, failure: EventFailureState, now: number): boolean {
    if (outcome.class === 'terminal') return true;
    if (outcome.class !== 'conflict') return false;
    return now - failure.firstFailedAt >= CONFLICT_RETRY_BUDGET_MS;
  }

  /**
   * When to wake up next.
   *
   * A held failure backs off exponentially from the poll interval, capped at
   * five minutes, so a conflict waiting on a dependency and an app outage both
   * stop hammering without the loop going to sleep for an hour. Otherwise a
   * poll that ran out of drain budget mid-backlog re-arms in a second, and one
   * whose last page came back short re-arms at the configured interval: a
   * short page is the stream saying it is caught up.
   */
  private nextDelaySeconds(result: PollResult): number {
    const interval = clampPollIntervalSeconds(this.env.SCIM_POLL_INTERVAL_SECONDS);

    if (result.heldFailure !== null) {
      return Math.min(interval * 2 ** (result.heldFailure.attempts - 1), MAX_RETRY_DELAY_SECONDS);
    }

    // A poll-level error is the Events API itself failing, which the interval
    // is already the retry for.
    if (result.error !== null) return interval;

    return result.caughtUp ? interval : CATCH_UP_DELAY_SECONDS;
  }

  /**
   * Total by construction: `poll` promises to report failures rather than
   * throw, and `alarm` relies on that to reach `setAlarm`, so a missing var
   * must not throw out of here.
   */
  private configuredCursor(): string | null {
    const configured = (this.env.WORKOS_EVENT_CURSOR ?? '').trim();
    return configured === '' ? null : configured;
  }
}

export function getScimSyncDOStub(env: Env): DurableObjectStub<ScimSyncDO> {
  return env.SCIM_SYNC_DO.getByName(SCIM_SYNC_DO_NAME);
}
