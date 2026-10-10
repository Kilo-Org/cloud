import { DurableObject } from 'cloudflare:workers';
import type { Env, Event } from './types';
import { EventStore } from './event-store';
import { WebhookDelivery } from './webhook-delivery';
import * as Sentry from '@sentry/cloudflare';

type EventsManagerState = {
  buildId: string;
};

export class EventsManager extends DurableObject<Env> {
  private state: EventsManagerState = {
    buildId: '',
  };

  private eventStore: EventStore;
  private webhookDelivery: WebhookDelivery;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.eventStore = new EventStore(this.ctx.storage);

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

  private async loadState(): Promise<void> {
    if (this.state.buildId !== '') {
      return;
    }

    const stored = await this.ctx.storage.get<EventsManagerState>('state');
    if (stored) {
      this.state = stored;
    }

    await this.eventStore.loadEvents();

    await this.webhookDelivery.initialize();
  }

  private async saveState(): Promise<void> {
    await this.ctx.storage.put('state', this.state);
  }

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

  async addEvent(eventData: Omit<Event, 'id' | 'ts'>): Promise<void> {
    await this.loadState();
    await this.eventStore.addEvent(eventData);
    await this.webhookDelivery.scheduleFlush();
  }

  async getEvents(): Promise<Event[]> {
    await this.loadState();
    return this.eventStore.getEvents();
  }
}
