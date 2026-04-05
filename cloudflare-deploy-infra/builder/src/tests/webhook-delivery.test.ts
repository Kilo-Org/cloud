/**
 * Comprehensive tests for webhook delivery functionality.
 *
 * Tests cover the following scenarios from the MVP plan:
 * - Happy path single batch delivery
 * - Multiple batches for large event streams
 * - Retryable failure then success with exponential backoff
 * - Stop-after exceeded (delivery permanently stopped)
 * - Preserve undelivered events
 * - Batch timing (waits up to BATCH_MAX_MS when below threshold)
 *
 * Uses a mock fetch implementation to simulate backend responses.
 */

import type { DeliveryState, Event, Build, Env, WebhookPayload } from '../types';
import { WebhookDelivery } from '../webhook-delivery';
import { EventStore } from '../event-store';

/**
 * Mock DurableObjectStorage for testing
 */
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

/**
 * Mock fetch responses for testing
 */
type MockFetchResponse = {
  ok: boolean;
  status: number;
};

let mockFetchResponses: MockFetchResponse[] = [];
let fetchCallCount = 0;
let lastFetchPayload: WebhookPayload | null = null;

const mockFetch = jest.fn(async (url: string, options?: RequestInit): Promise<Response> => {
  fetchCallCount++;

  // Capture the payload for assertions
  if (options?.body) {
    lastFetchPayload = JSON.parse(options.body as string) as WebhookPayload;
  }

  const response = mockFetchResponses.shift() || { ok: true, status: 200 };

  return {
    ok: response.ok,
    status: response.status,
  } as Response;
});

// Mock global fetch
global.fetch = mockFetch as unknown as typeof fetch;

/**
 * Helper to create test environment
 */
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

/**
 * Test helper class that wraps WebhookDelivery and EventStore
 */
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
    // Reset mock state
    mockFetchResponses = [];
    fetchCallCount = 0;
    lastFetchPayload = null;
    mockFetch.mockClear();
  });

  it('should deliver a single batch successfully (happy path)', async () => {
    const env = createTestEnv();
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    // Add some events
    await handler.addEvent('Event 1');
    await handler.addEvent('Event 2');
    await handler.addEvent('Event 3');

    // Mock successful response
    mockFetchResponses.push({ ok: true, status: 200 });

    // Flush events
    await handler.flush();

    // Verify delivery
    expect(fetchCallCount).toBe(1);
    expect(lastFetchPayload).toBeTruthy();
    expect(lastFetchPayload!.events.length).toBe(3);
    expect(lastFetchPayload!.events[0].type).toBe('log');
    expect((lastFetchPayload!.events[0].payload as { message: string }).message).toBe('Event 1');
    expect((lastFetchPayload!.events[2].payload as { message: string }).message).toBe('Event 3');

    // Verify delivery state updated
    const deliveryState = handler.getDeliveryState();
    expect(deliveryState).toBeTruthy();
    expect(deliveryState!.attempt).toBe(0);
    expect(deliveryState!.nextAttemptAt).toBe(0);

    // Verify last processed ID updated
    expect(handler.getLastProcessedId()).toBe(2);
  });

  it('should split large event streams into multiple batches', async () => {
    const env = createTestEnv({
      BACKEND_WEBHOOK_BATCH_MAX_EVENTS: '10', // Small batch size for testing
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    // Add 25 events
    for (let i = 0; i < 25; i++) {
      await handler.addEvent(`Event ${i + 1}`);
    }

    // Mock successful responses for 3 batches
    mockFetchResponses.push({ ok: true, status: 200 });
    mockFetchResponses.push({ ok: true, status: 200 });
    mockFetchResponses.push({ ok: true, status: 200 });

    // First batch: events 0-9
    await handler.flush();
    expect(fetchCallCount).toBe(1);
    expect(lastFetchPayload!.events.length).toBe(10);
    expect(lastFetchPayload!.events[0].id).toBe(0);
    expect(lastFetchPayload!.events[9].id).toBe(9);

    // Second batch: events 10-19
    await handler.flush();
    expect(fetchCallCount).toBe(2);
    expect(lastFetchPayload!.events.length).toBe(10);
    expect(lastFetchPayload!.events[0].id).toBe(10);
    expect(lastFetchPayload!.events[9].id).toBe(19);

    // Third batch: events 20-24
    await handler.flush();
    expect(fetchCallCount).toBe(3);
    expect(lastFetchPayload!.events.length).toBe(5);
    expect(lastFetchPayload!.events[0].id).toBe(20);
    expect(lastFetchPayload!.events[4].id).toBe(24);

    // Verify final state
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

    // First attempt: fail with 503
    mockFetchResponses.push({ ok: false, status: 503 });
    await handler.flush();

    expect(fetchCallCount).toBe(1);
    let deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(1);
    expect(deliveryState!.nextAttemptAt).toBeGreaterThan(Date.now());

    // Calculate expected backoff: 1000 * 2^0 = 1000ms
    const firstBackoff = deliveryState!.nextAttemptAt - Date.now();
    expect(firstBackoff).toBeGreaterThanOrEqual(900);
    expect(firstBackoff).toBeLessThanOrEqual(1100);

    // Second attempt: fail with 500
    mockFetchResponses.push({ ok: false, status: 500 });
    await handler.flush();

    expect(fetchCallCount).toBe(2);
    deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(2);

    // Calculate expected backoff: 1000 * 2^1 = 2000ms
    const secondBackoff = deliveryState!.nextAttemptAt - Date.now();
    expect(secondBackoff).toBeGreaterThanOrEqual(1900);
    expect(secondBackoff).toBeLessThanOrEqual(2100);

    // Third attempt: succeed
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
      BACKEND_WEBHOOK_STOP_AFTER_ATTEMPTS: '2', // Very low for testing
      BACKEND_WEBHOOK_BACKOFF_BASE_MS: '10',
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    await handler.addEvent('Event 1');

    // First failure
    mockFetchResponses.push({ ok: false, status: 503 });
    await handler.flush();

    let deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(1);

    // Second failure
    mockFetchResponses.push({ ok: false, status: 503 });
    await handler.flush();

    deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(2);

    // Third failure - should exceed limit
    mockFetchResponses.push({ ok: false, status: 503 });
    await handler.flush();

    deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(3);

    // Verify no more retries happen (attempt > STOP_AFTER_ATTEMPTS)
    mockFetchResponses.push({ ok: true, status: 200 });
    await handler.flush();

    // fetchCallCount should still be 3 (no fourth attempt)
    expect(fetchCallCount).toBe(3);
  });

  it('should preserve undelivered events', async () => {
    const env = createTestEnv({
      BACKEND_WEBHOOK_BATCH_MAX_EVENTS: '5',
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    // Add events and deliver some
    for (let i = 0; i < 10; i++) {
      await handler.addEvent(`Event ${i + 1}`);
    }

    // Deliver first 5 events
    mockFetchResponses.push({ ok: true, status: 200 });
    await handler.flush();

    expect(handler.getLastProcessedId()).toBe(4);

    // Add more events
    for (let i = 10; i < 15; i++) {
      await handler.addEvent(`Event ${i + 1}`);
    }

    // Verify undelivered events are preserved
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

    // Add only 3 events (below threshold of 10)
    await handler.addEvent('Event 1');
    await handler.addEvent('Event 2');
    await handler.addEvent('Event 3');

    // Verify alarm is scheduled
    const alarmTime = handler.getAlarmTime();
    expect(alarmTime).toBeTruthy();
    expect(alarmTime!).toBeGreaterThan(Date.now());

    // Alarm should be scheduled for approximately BATCH_MAX_MS in the future
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

    // Add exactly 5 events (at threshold)
    for (let i = 0; i < 5; i++) {
      await handler.addEvent(`Event ${i + 1}`);
    }

    // Should schedule immediate flush (50ms)
    const alarmTime = handler.getAlarmTime();
    expect(alarmTime).toBeTruthy();
    const delay = alarmTime! - Date.now();
    expect(delay).toBeLessThan(100);

    // Flush should send immediately
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

    // Start first flush
    mockFetchResponses.push({ ok: true, status: 200 });
    const firstFlush = handler.flush();

    // Try to start second flush while first is in progress
    mockFetchResponses.push({ ok: true, status: 200 });
    const secondFlush = handler.flush();

    await Promise.all([firstFlush, secondFlush]);

    // Should only make one fetch call due to reentrancy guard
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

    // Try to schedule flush with no events
    await handler.flush();

    // Should not have made any fetch calls
    expect(fetchCallCount).toBe(0);

    // Should not have scheduled an alarm
    expect(handler.getAlarmTime()).toBeNull();
  });

  it('should handle retry scheduling correctly', async () => {
    const env = createTestEnv({
      BACKEND_WEBHOOK_BACKOFF_BASE_MS: '1000',
    });
    const handler = new TestWebhookDeliveryHandler(env);

    await handler.initialize();

    await handler.addEvent('Event 1');

    // First attempt: fail
    mockFetchResponses.push({ ok: false, status: 503 });
    await handler.flush();

    const deliveryState = handler.getDeliveryState();
    expect(deliveryState!.attempt).toBe(1);

    // Verify alarm is set to nextAttemptAt
    const alarmTime = handler.getAlarmTime();
    expect(alarmTime).toBe(deliveryState!.nextAttemptAt);
  });
});
