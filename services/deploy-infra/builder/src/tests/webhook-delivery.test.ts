import type { DeliveryState, Event, Build, Env, WebhookPayload } from '../types';
import { WebhookDelivery } from '../webhook-delivery';
import { EventStore } from '../event-store';

class MockDurableObjectStorage {
  private storage = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.storage.get(key) as T | undefined;
  }

  async put(keyOrObject: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrObject === 'string') {
      this.storage.set(keyOrObject, value);
    } else {
      for (const [k, v] of Object.entries(keyOrObject)) {
        this.storage.set(k, v);
      }
    }
  }

  async delete(key: string): Promise<boolean> {
    return this.storage.delete(key);
  }

  async list(): Promise<Map<string, unknown>> {
    return new Map(this.storage);
  }
}

type MockFetchResponse = {
  ok: boolean;
  status: number;
};

let mockFetchResponses: MockFetchResponse[] = [];
let fetchCallCount = 0;
let lastFetchPayload: WebhookPayload | null = null;

const mockFetch = jest.fn(async (url: string, options?: RequestInit): Promise<Response> => {
  fetchCallCount++;

  if (options?.body) {
    lastFetchPayload = JSON.parse(options.body as string) as WebhookPayload;
  }

  const response = mockFetchResponses.shift() || { ok: true, status: 200 };

  return {
    ok: response.ok,
    status: response.status,
  } as Response;
});

global.fetch = mockFetch as unknown as typeof fetch;

function createTestEnv(overrides?: Partial<Env>): Env {
  return {
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    CLOUDFLARE_API_TOKEN: 'test-token',
    BACKEND_AUTH_TOKEN: 'test-auth',
    BACKEND_EVENTS_URL: 'https://api.test.com/events',
    BACKEND_WEBHOOK_BATCH_MAX_EVENTS: '50',
    BACKEND_WEBHOOK_BATCH_MAX_MS: '3000',
    BACKEND_WEBHOOK_BACKOFF_BASE_MS: '2000',
    BACKEND_WEBHOOK_STOP_AFTER_ATTEMPTS: '10',
    ...overrides,
  } as Env;
}

class TestWebhookDeliveryHandler {
  private storage: MockDurableObjectStorage;
  private eventStore: EventStore;
  private webhookDelivery: WebhookDelivery;
  private buildState: Build;
  private alarmTime: number | null = null;

  constructor(env: Env) {
    this.storage = new MockDurableObjectStorage();
    this.eventStore = new EventStore(this.storage as unknown as DurableObjectStorage);

    this.buildState = {
      buildId: 'test-build-123',
      slug: 'test-build',
      source: {
        type: 'git',
        provider: 'github',
        repoSource: 'test/repo',
      },
      status: 'building' as const,
      updatedAt: new Date().toISOString(),
    };

    const alarm = {
      get: async () => this.alarmTime,
      set: async (timestamp: number) => {
        this.alarmTime = timestamp;
      },
    };

    this.webhookDelivery = new WebhookDelivery(
      this.storage as unknown as DurableObjectStorage,
      env,
      () => this.buildState.buildId,
      alarm,
      this.eventStore
    );
  }

  async initialize(): Promise<void> {
    await this.eventStore.loadEvents();
    await this.webhookDelivery.initialize();
  }

  async addEvent(message: string): Promise<Event> {
    const event = await this.eventStore.addEvent({
      type: 'log',
      payload: { message },
    });
    this.buildState.updatedAt = event.ts;
    await this.webhookDelivery.scheduleFlush();
    return event;
  }

  async flush(): Promise<void> {
    await this.webhookDelivery.flush();
  }

  getDeliveryState(): DeliveryState | null {
    return this.webhookDelivery.getDeliveryState();
  }

  getEvents(): Event[] {
    return this.eventStore.getEvents();
  }

  getUnprocessedEvents(limit?: number): Event[] {
    return this.eventStore.getUnprocessedEvents(limit);
  }

  getLastProcessedId(): number {
    return this.eventStore.getLastProcessedId();
  }

  getAlarmTime(): number | null {
    return this.alarmTime;
  }

  clearAlarm(): void {
    this.alarmTime = null;
  }
}

describe('Webhook Delivery', () => {
  beforeEach(() => {
    mockFetchResponses = [];
    fetchCallCount = 0;
    lastFetchPayload = null;
    mockFetch.mockClear();
  });

  it('should deliver a single batch successfully (happy path)', async () => {
    const env = createTestEnv();
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    await handler.addEvent('Event 1');
    await handler.addEvent('Event 2');
    await handler.addEvent('Event 3');

    mockFetchResponses.push({ ok: true, status: 200 });

    await handler.flush();

    expect(fetchCallCount).toBe(1);
    expect(lastFetchPayload).toBeTruthy();
    expect(lastFetchPayload!.events.length).toBe(3);
    expect(lastFetchPayload!.events[0].type).toBe('log');
    expect((lastFetchPayload!.events[0].payload as { message: string }).message).toBe('Event 1');
    expect((lastFetchPayload!.events[2].payload as { message: string }).message).toBe('Event 3');

    const deliveryState = handler.getDeliveryState();
    expect(deliveryState).toBeTruthy();
    expect(deliveryState!.attempt).toBe(0);
    expect(deliveryState!.nextAttemptAt).toBe(0);

    expect(handler.getLastProcessedId()).toBe(2);
  });

  it('should split large event streams into multiple batches', async () => {
    const env = createTestEnv({
      BACKEND_WEBHOOK_BATCH_MAX_EVENTS: '10',
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    for (let i = 0; i < 25; i++) {
      await handler.addEvent(`Event ${i + 1}`);
    }

    mockFetchResponses.push({ ok: true, status: 200 });
    mockFetchResponses.push({ ok: true, status: 200 });
    mockFetchResponses.push({ ok: true, status: 200 });

    await handler.flush();
    expect(fetchCallCount).toBe(1);
    expect(lastFetchPayload!.events.length).toBe(10);
    expect(lastFetchPayload!.events[0].id).toBe(0);
    expect(lastFetchPayload!.events[9].id).toBe(9);

    await handler.flush();
    expect(fetchCallCount).toBe(2);
    expect(lastFetchPayload!.events.length).toBe(10);
    expect(lastFetchPayload!.events[0].id).toBe(10);
    expect(lastFetchPayload!.events[9].id).toBe(19);

    await handler.flush();
    expect(fetchCallCount).toBe(3);
    expect(lastFetchPayload!.events.length).toBe(5);
    expect(lastFetchPayload!.events[0].id).toBe(20);
    expect(lastFetchPayload!.events[4].id).toBe(24);

    expect(handler.getLastProcessedId()).toBe(24);
  });

  it('should apply exponential backoff on retryable failure then succeed', async () => {
    const env = createTestEnv({
      BACKEND_WEBHOOK_BACKOFF_BASE_MS: '1000',
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    await handler.addEvent('Event 1');
    await handler.addEvent('Event 2');

    mockFetchResponses.push({ ok: false, status: 503 });
    await handler.flush();

    expect(fetchCallCount).toBe(1);
    let deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(1);
    expect(deliveryState!.nextAttemptAt).toBeGreaterThan(Date.now());

    const firstBackoff = deliveryState!.nextAttemptAt - Date.now();
    expect(firstBackoff).toBeGreaterThanOrEqual(900);
    expect(firstBackoff).toBeLessThanOrEqual(1100);

    mockFetchResponses.push({ ok: false, status: 500 });
    await handler.flush();

    expect(fetchCallCount).toBe(2);
    deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(2);

    const secondBackoff = deliveryState!.nextAttemptAt - Date.now();
    expect(secondBackoff).toBeGreaterThanOrEqual(1900);
    expect(secondBackoff).toBeLessThanOrEqual(2100);

    mockFetchResponses.push({ ok: true, status: 200 });
    await handler.flush();

    expect(fetchCallCount).toBe(3);
    deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(0);
    expect(deliveryState!.nextAttemptAt).toBe(0);
    expect(handler.getLastProcessedId()).toBe(1);
  });

  it('should stop retrying after STOP_AFTER_ATTEMPTS is exceeded', async () => {
    const env = createTestEnv({
      BACKEND_WEBHOOK_STOP_AFTER_ATTEMPTS: '2',
      BACKEND_WEBHOOK_BACKOFF_BASE_MS: '10',
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    await handler.addEvent('Event 1');

    mockFetchResponses.push({ ok: false, status: 503 });
    await handler.flush();

    let deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(1);

    mockFetchResponses.push({ ok: false, status: 503 });
    await handler.flush();

    deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(2);

    mockFetchResponses.push({ ok: false, status: 503 });
    await handler.flush();

    deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(3);

    mockFetchResponses.push({ ok: true, status: 200 });
    await handler.flush();

    expect(fetchCallCount).toBe(3);
  });

  it('should preserve undelivered events', async () => {
    const env = createTestEnv({
      BACKEND_WEBHOOK_BATCH_MAX_EVENTS: '5',
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    for (let i = 0; i < 10; i++) {
      await handler.addEvent(`Event ${i + 1}`);
    }

    mockFetchResponses.push({ ok: true, status: 200 });
    await handler.flush();

    expect(handler.getLastProcessedId()).toBe(4);

    for (let i = 10; i < 15; i++) {
      await handler.addEvent(`Event ${i + 1}`);
    }

    const unprocessedEvents = handler.getUnprocessedEvents();
    expect(unprocessedEvents.length).toBe(10); // Events 5-14
    expect(unprocessedEvents[0].id).toBe(5);
    expect(unprocessedEvents[9].id).toBe(14);
  });

  it('should wait for batch timing when below threshold', async () => {
    const env = createTestEnv({
      BACKEND_WEBHOOK_BATCH_MAX_EVENTS: '10',
      BACKEND_WEBHOOK_BATCH_MAX_MS: '3000',
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    await handler.addEvent('Event 1');
    await handler.addEvent('Event 2');
    await handler.addEvent('Event 3');

    const alarmTime = handler.getAlarmTime();
    expect(alarmTime).toBeTruthy();
    expect(alarmTime!).toBeGreaterThan(Date.now());

    const delay = alarmTime! - Date.now();
    expect(delay).toBeGreaterThan(2900);
    expect(delay).toBeLessThan(3100);
  });

  it('should send immediately when batch size threshold is reached', async () => {
    const env = createTestEnv({
      BACKEND_WEBHOOK_BATCH_MAX_EVENTS: '5',
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    for (let i = 0; i < 5; i++) {
      await handler.addEvent(`Event ${i + 1}`);
    }

    const alarmTime = handler.getAlarmTime();
    expect(alarmTime).toBeTruthy();
    const delay = alarmTime! - Date.now();
    expect(delay).toBeLessThan(100);

    mockFetchResponses.push({ ok: true, status: 200 });
    await handler.flush();

    expect(fetchCallCount).toBe(1);
    expect(lastFetchPayload!.events.length).toBe(5);
  });

  it('should handle reentrancy guard correctly', async () => {
    const env = createTestEnv();
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    await handler.addEvent('Event 1');

    mockFetchResponses.push({ ok: true, status: 200 });
    const firstFlush = handler.flush();

    mockFetchResponses.push({ ok: true, status: 200 });
    const secondFlush = handler.flush();

    await Promise.all([firstFlush, secondFlush]);

    expect(fetchCallCount).toBe(1);
  });

  it('should include correct build metadata in webhook payload', async () => {
    const env = createTestEnv();
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    await handler.addEvent('Build started');

    mockFetchResponses.push({ ok: true, status: 200 });
    await handler.flush();

    expect(lastFetchPayload).toBeTruthy();
    expect(lastFetchPayload!.buildId).toBe('test-build-123');
  });

  it('should not schedule flush when no pending events', async () => {
    const env = createTestEnv();
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    await handler.flush();

    expect(fetchCallCount).toBe(0);

    expect(handler.getAlarmTime()).toBeNull();
  });

  it('should handle retry scheduling correctly', async () => {
    const env = createTestEnv({
      BACKEND_WEBHOOK_BACKOFF_BASE_MS: '1000',
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    await handler.addEvent('Event 1');

    mockFetchResponses.push({ ok: false, status: 503 });
    await handler.flush();

    const deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(1);

    const alarmTime = handler.getAlarmTime();
    expect(alarmTime).toBe(deliveryState!.nextAttemptAt);
  });
});
