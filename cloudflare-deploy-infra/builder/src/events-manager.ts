/**
 * EventsManager - Durable Object for managing events and webhook delivery.
 * One instance per build, owns EventStore and WebhookDelivery.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env, Event } from './types';
import { EventStore } from './event-store';
import { WebhookDelivery } from './webhook-delivery';
import * as Sentry from '@sentry/cloudflare';

/**
 * State structure for EventsManager
 */
type EventsManagerState = {
  buildId: string;
};

/**
 * EventsManager Durable Object
 *
 * Responsibilities:
 * - Own and manage EventStore instance
 * - Handle webhook delivery with WebhookDelivery class
 * - Provide RPC methods for adding events
 * - Manage alarm for webhook batching and retries
 * - Track build state for webhook payloads
 */
export class EventsManager extends DurableObject<Env> {
  private state: EventsManagerState = {
    buildId: '',
  };

  private eventStore: EventStore;
  private webhookDelivery: WebhookDelivery;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Initialize EventStore with this DO's storage
    this.eventStore = new EventStore(this.ctx.storage);

    // Initialize WebhookDelivery with storage, env, build state accessor, alarm interface, and event store
    this.webhookDelivery = new WebhookDelivery(
      this.ctx.storage,
      this.env,
      () => this.state.buildId,
      {
        get: () => this.ctx.storage.getAlarm(),
        set: (timestamp: number) => this.ctx.storage.setAlarm(timestamp),
      },
      this.eventStore
    );
  }

  async initialize(buildId: string): Promise<void> {
    await this.loadState();
    if (!this.state.buildId || this.state.buildId !== buildId) {
      this.state.buildId = buildId;
      await this.saveState();
    }
  }

  /**
   * Load state from storage
   */
  private async loadState(): Promise<void> {
    if (this.state.buildId !== '') {
      return;
    }

    const stored = await this.ctx.storage.get<EventsManagerState>('state');
    if (stored) {
      this.state = stored;
    }

    // Load EventStore events from storage
    await this.eventStore.loadEvents();

    // Initialize WebhookDelivery
    await this.webhookDelivery.initialize();
  }

  /**
   * Save state to storage
   */
  private async saveState(): Promise<void> {
    await this.ctx.storage.put('state', this.state);
  }

  /**
   * Alarm handler for webhook delivery
   */
  async alarm(): Promise<void> {
    try {
      await this.loadState();
      await this.webhookDelivery.flush();
    } catch (error) {
      Sentry.captureException(error, {
        level: 'error',
        tags: { source: 'events-manager-alarm' },
        extra: { buildId: this.state.buildId },
      });
      throw error;
    }
  }

  /**
   * RPC: Add a new event
   *
   * @param eventData - Event data without id and ts (will be added by EventStore)
   */
  async addEvent(eventData: Omit<Event, 'id' | 'ts'>): Promise<void> {
    await this.loadState();
    await this.eventStore.addEvent(eventData);
    await this.webhookDelivery.scheduleFlush();
  }

  /**
   * RPC: Get all events
   *
   * @returns Array of all events
   */
  async getEvents(): Promise<Event[]> {
    await this.loadState();
    return this.eventStore.getEvents();
  }
}
