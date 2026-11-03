import { DurableObject } from 'cloudflare:workers';
import { WorkOS, type Event, type EventName } from '@workos-inc/node';

import { logger } from '../util/logger';

/**
 * The WorkOS Events API is scoped to the environment its API key belongs to,
 * and WorkOS prescribes a single serial consumer of the stream, so this
 * namespace holds exactly one instance.
 */
export const SCIM_SYNC_DO_NAME = 'scim-sync';

/**
 * Directory Sync events, as named by the SDK's `EventName` union. Listing them
 * is required: the Events API rejects a request with no `events` filter.
 */
const DSYNC_EVENTS: EventName[] = [
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
];

/** Events requested per poll. Small on purpose: this iteration only logs. */
const PAGE_LIMIT = 10;

const DEFAULT_INTERVAL_SECONDS = 60;
/**
 * A sub-second interval would leave the Durable Object no idle window to
 * hibernate in, billing its full 128 MB allocation continuously.
 */
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 3600;

export type ScimSyncDOStatus = {
  instance: string;
  environment: string;
  pollIntervalSeconds: number;
  cursor: string | null;
  nextAlarmAt: number | null;
  lastPoll: PollResult | null;
};

export type PollResult = {
  at: string;
  /** Events returned by the request, all of which were logged. */
  eventCount: number;
  /** ID of the last event in the page, to copy into `WORKOS_EVENT_CURSOR`. */
  lastEventId: string | null;
  error: string | null;
};

/** Storage key for the last poll result. */
const LAST_POLL_KEY = 'lastPoll';

export class ScimSyncDO extends DurableObject<Env> {
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
    return {
      instance: SCIM_SYNC_DO_NAME,
      environment: this.env.ENVIRONMENT,
      pollIntervalSeconds: this.pollIntervalSeconds(),
      cursor: this.cursor(),
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
    // a successful poll would then report nothing. Workers Logs remains the
    // durable record of the events themselves.
    await this.ctx.storage.put(LAST_POLL_KEY, await this.poll());
    await this.ctx.storage.setAlarm(Date.now() + this.pollIntervalSeconds() * 1000);
  }

  /**
   * Fetches one page of directory-sync events and logs each one. Exposed as an
   * RPC so a single poll can be driven without waiting for the alarm.
   */
  async poll(): Promise<PollResult> {
    const at = new Date().toISOString();
    const cursor = this.cursor();

    try {
      const workos = new WorkOS(await this.env.WORKOS_API_KEY.get(), {
        clientId: await this.env.WORKOS_CLIENT_ID.get(),
        // The SDK retries 4xx-adjacent and 5xx responses internally. Leaving
        // that on would stretch a single alarm across several attempts and hide
        // the failure; the alarm interval is the retry.
        maxRetries: 0,
      });

      const page = await workos.events.listEvents({
        events: DSYNC_EVENTS,
        limit: PAGE_LIMIT,
        ...(cursor === null ? {} : { after: cursor }),
      });

      for (const event of page.data) {
        logEvent(event);
      }

      const lastEventId = page.data.at(-1)?.id ?? null;
      logger.info('SCIM sync poll complete', {
        eventCount: page.data.length,
        cursor,
        lastEventId,
      });

      return { at, eventCount: page.data.length, lastEventId, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('SCIM sync poll failed', { error: message, cursor });
      return { at, eventCount: 0, lastEventId: null, error: message };
    }
  }

  /** `vars` are strings, so an unparseable value must not reach `setAlarm`. */
  private pollIntervalSeconds(): number {
    const parsed = Number(this.env.SCIM_POLL_INTERVAL_SECONDS);
    if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_SECONDS;
    return Math.min(Math.max(Math.trunc(parsed), MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
  }

  private cursor(): string | null {
    const configured = this.env.WORKOS_EVENT_CURSOR.trim();
    return configured === '' ? null : configured;
  }
}

/**
 * Logs one event. Only envelope fields: an event's `data` carries directory
 * user attributes (emails, names, raw IdP attributes) that must not reach
 * Workers Logs.
 */
function logEvent(event: Event): void {
  logger.info('WorkOS directory event', {
    eventId: event.id,
    eventType: event.event,
    eventCreatedAt: event.createdAt,
  });
}

export function getScimSyncDOStub(env: Env): DurableObjectStub<ScimSyncDO> {
  return env.SCIM_SYNC_DO.getByName(SCIM_SYNC_DO_NAME);
}
