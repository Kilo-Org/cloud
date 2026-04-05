/**
 * WebhookDelivery - Manages webhook delivery with batching and retry logic.
 * Handles delivery state, exponential backoff, and batch scheduling.
 */

import type { Env, Event, DeliveryState, WebhookPayload } from './types';
import type { EventStore } from './event-store';
import { logExceptInTest, errorExceptInTest } from './utils';
import * as Sentry from '@sentry/cloudflare';

const DELIVERY_STATE_KEY = 'deliveryState';

export class WebhookDelivery {
  /** In-memory cache of delivery state */
  private deliveryState: DeliveryState | null = null;
  /** Reentrancy guard - only needs to be in-memory since requests are cancelled on sleep */
  private isFlushing = false;

  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
    private getBuildId: () => string,
    private alarm: {
      get: () => Promise<number | null>;
      set: (timestamp: number) => Promise<void>;
    },
    private eventStore: EventStore
  ) {}

  /**
   * Initialize the webhook delivery system by loading delivery state.
   */
  async initialize(): Promise<void> {
    await this.loadDeliveryState();
  }

  /**
   * Load delivery state from durable storage.
   * Returns a default DeliveryState if not found in storage.
   * Caches the result in memory for subsequent access.
   */
  private async loadDeliveryState(): Promise<DeliveryState> {
    const stored = await this.storage.get<DeliveryState>(DELIVERY_STATE_KEY);

    if (stored) {
      this.deliveryState = stored;
    } else {
      // Initialize with default values
      this.deliveryState = {
        nextAttemptAt: 0,
        attempt: 0,
      };
    }

    return this.deliveryState;
  }

  /**
   * Save delivery state to durable storage.
   * Persists the current in-memory delivery state.
   */
  private async saveDeliveryState(): Promise<void> {
    await this.storage.put(DELIVERY_STATE_KEY, this.deliveryState);
  }

  /**
   * Get the current delivery state.
   */
  getDeliveryState(): DeliveryState | null {
    return this.deliveryState;
  }

  // Internal: centralized configuration values parsed from env
  private getConfig() {
    return {
      BATCH_MAX_EVENTS: Number(this.env.BACKEND_WEBHOOK_BATCH_MAX_EVENTS) || 100,
      BATCH_MAX_MS: Number(this.env.BACKEND_WEBHOOK_BATCH_MAX_MS) || 2000,
      BACKOFF_BASE_MS: Number(this.env.BACKEND_WEBHOOK_BACKOFF_BASE_MS) || 2000,
      STOP_AFTER_ATTEMPTS: Number(this.env.BACKEND_WEBHOOK_STOP_AFTER_ATTEMPTS) || 10,
    };
  }

  // Internal: compute backoff delay
  private computeBackoffDelay(attempt: number, baseMs: number): number {
    const pow = attempt > 0 ? attempt - 1 : 0;
    return baseMs * Math.pow(2, pow);
  }

  /**
   * Schedule a flush
   */
  async scheduleFlush(): Promise<void> {
    if (!this.deliveryState) {
      return;
    }

    const { BATCH_MAX_EVENTS, BATCH_MAX_MS, STOP_AFTER_ATTEMPTS } = this.getConfig();
    const pendingEventsCount = this.eventStore.getUnprocessedEvents(BATCH_MAX_EVENTS).length;

    if (pendingEventsCount === 0) {
      return;
    }

    // Retry phase
    if (this.deliveryState.attempt > 0) {
      if (this.deliveryState.attempt > STOP_AFTER_ATTEMPTS) {
        return;
      }

      await this.alarm.set(this.deliveryState.nextAttemptAt);
      return;
    }

    // Overflow phase
    if (pendingEventsCount >= BATCH_MAX_EVENTS) {
      await this.alarm.set(Date.now() + 50);
      return;
    }

    // Batch timing phase
    const nextAlarm = Date.now() + BATCH_MAX_MS;
    const currentAlarm = await this.alarm.get();

    // There is already an alarm scheduled
    if (currentAlarm && nextAlarm > currentAlarm) {
      return;
    }

    await this.alarm.set(nextAlarm);
  }

  /**
   * Flush pending events to the backend webhook endpoint.
   */
  async flush(): Promise<void> {
    if (!this.deliveryState) {
      return;
    }

    // Guard against reentrancy
    if (this.isFlushing) {
      return;
    }

    // Get webhook configuration
    const { BATCH_MAX_EVENTS, STOP_AFTER_ATTEMPTS } = this.getConfig();

    // Check if delivery has been permanently stopped
    if (this.deliveryState.attempt > STOP_AFTER_ATTEMPTS) {
      return;
    }

    try {
      // Set reentrancy guard
      this.isFlushing = true;

      // Get batch of events to send
      const eventsToSend = this.eventStore.getUnprocessedEvents(BATCH_MAX_EVENTS);

      // If no events to send, return early
      if (eventsToSend.length === 0) {
        return;
      }

      const lastDeliveredEventId = await this.sendEvents(eventsToSend);

      if (lastDeliveredEventId !== null) {
        // Events were successfully delivered
        await this.eventStore.setLastProcessedId(lastDeliveredEventId);

        // Reset backoff state
        this.deliveryState.attempt = 0;
        this.deliveryState.nextAttemptAt = 0;
      } else {
        this.deliveryState.attempt += 1;
        this.deliveryState.nextAttemptAt =
          Date.now() +
          this.computeBackoffDelay(this.deliveryState.attempt, this.getConfig().BACKOFF_BASE_MS);
      }

      await this.saveDeliveryState();
      await this.scheduleFlush();
    } finally {
      // Always clear reentrancy guard
      this.isFlushing = false;
    }
  }

  private async sendEvents(events: Event[]): Promise<number | null> {
    // If there is no backend URL configured, skip sending events
    if (!this.env.BACKEND_EVENTS_URL || this.env.BACKEND_EVENTS_URL.trim() === '') {
      return events[events.length - 1].id;
    }

    // Build webhook payload
    const payload: WebhookPayload = {
      buildId: this.getBuildId(),
      events: events,
    };

    // Send webhook to backend
    try {
      const response = await fetch(this.env.BACKEND_EVENTS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.env.BACKEND_AUTH_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const lastEventId = events[events.length - 1].id;

        logExceptInTest(
          `Successfully delivered events till ${lastEventId} for build ${this.getBuildId()}`
        );

        return lastEventId;
      } else {
        const responseText = await response.text();

        Sentry.captureMessage(
          `Webhook delivery failed with status ${response.status}, ${responseText}`,
          {
            level: 'warning',
            tags: { source: 'deploy-events-webhook' },
          }
        );
        errorExceptInTest(`Webhook delivery failed with status ${response.status}`);
        return null;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Sentry.captureMessage(`Webhook delivery failed: ${errorMessage}`, {
        level: 'warning',
        tags: { source: 'deploy-events-webhook' },
      });
      errorExceptInTest(`Webhook delivery error: ${errorMessage}`);
      return null;
    }
  }
}
