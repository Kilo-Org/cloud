import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  webhook_event_signatures,
  webhook_events,
  webhook_events_v2,
  type User,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { logWebhookEvent, updateWebhookEvent } from './webhook-events';
import {
  provisionWebhookEventPartitions,
  webhookEventPartitionName,
} from './webhook-event-partitions';

async function findEventBySignature(signature: string) {
  const [event] = await db
    .select()
    .from(webhook_events_v2)
    .where(eq(webhook_events_v2.event_signature, signature));
  if (!event) throw new Error(`webhook_events_v2 row ${signature} not found`);
  return event;
}

function eventInput(userId: string, eventSignature: string) {
  return {
    owner: { type: 'user' as const, id: userId },
    platform: 'github',
    event_type: 'pull_request',
    event_action: 'opened',
    payload: { action: 'opened' },
    headers: { 'x-github-event': 'pull_request' },
    event_signature: eventSignature,
  };
}

describe('logWebhookEvent NUL sanitization', () => {
  let user: User;

  beforeEach(async () => {
    user = await insertTestUser();
  });

  afterEach(cleanupDbForTest);

  test('strips NUL bytes from nested payload strings and header values', async () => {
    const eventSignature = `nul-${crypto.randomUUID()}`;

    const result = await logWebhookEvent({
      owner: { type: 'user', id: user.id },
      platform: 'github',
      event_type: 'pull_request_review_comment',
      event_action: 'created',
      payload: {
        action: 'created',
        comment: {
          body: 'hello\u0000world',
          diff_hunk: '\u0000@@ -1 +1 @@\u0000',
        },
        labels: ['a\u0000b', 'clean'],
        count: 2,
        draft: false,
        reviewer: null,
      },
      headers: {
        'x-github-event': 'pull_request_review_comment',
        'x-request-id': 'req\u0000id',
      },
      event_signature: eventSignature,
    });

    expect(result.isDuplicate).toBe(false);

    const stored = await findEventBySignature(eventSignature);
    expect(stored.payload).toEqual({
      action: 'created',
      comment: {
        body: 'helloworld',
        diff_hunk: '@@ -1 +1 @@',
      },
      labels: ['ab', 'clean'],
      count: 2,
      draft: false,
      reviewer: null,
    });
    expect(stored.headers).toEqual({
      'x-github-event': 'pull_request_review_comment',
      'x-request-id': 'reqid',
    });
  });

  test('preserves a __proto__ payload key through sanitization and the jsonb insert', async () => {
    const eventSignature = `proto-${crypto.randomUUID()}`;
    const payload = JSON.parse('{"__proto__":{"polluted":true},"action":"created"}');

    await logWebhookEvent({
      owner: { type: 'user', id: user.id },
      platform: 'github',
      event_type: 'pull_request_review_comment',
      event_action: 'created',
      payload,
      headers: { 'x-github-event': 'pull_request_review_comment' },
      event_signature: eventSignature,
    });

    const stored = await findEventBySignature(eventSignature);
    expect(stored.payload).toEqual(
      JSON.parse('{"__proto__":{"polluted":true},"action":"created"}')
    );
  });

  test('leaves a clean payload and headers unchanged', async () => {
    const eventSignature = `clean-${crypto.randomUUID()}`;
    const payload = {
      action: 'opened',
      installation: { id: 98765 },
      nested: { list: ['x', 'y'] },
      count: 2,
      draft: false,
      reviewer: null,
    };
    const headers = {
      'x-github-event': 'pull_request',
      'content-type': 'application/json',
    };

    await logWebhookEvent({
      owner: { type: 'user', id: user.id },
      platform: 'github',
      event_type: 'pull_request',
      event_action: 'opened',
      payload,
      headers,
      event_signature: eventSignature,
    });

    const stored = await findEventBySignature(eventSignature);
    expect(stored.payload).toEqual(payload);
    expect(stored.headers).toEqual(headers);
  });
});

describe('logWebhookEvent deduplication', () => {
  let user: User;

  beforeEach(async () => {
    user = await insertTestUser();
  });

  afterEach(cleanupDbForTest);

  test('stores the event and its signature claim with the returned identity', async () => {
    const eventSignature = `delivery-${crypto.randomUUID()}`;

    const result = await logWebhookEvent(eventInput(user.id, eventSignature));

    expect(result.isDuplicate).toBe(false);
    const stored = await findEventBySignature(eventSignature);
    expect(stored.id).toBe(result.event?.id);
    expect(new Date(stored.created_at).toISOString()).toBe(result.event?.createdAt);
    const [claim] = await db
      .select()
      .from(webhook_event_signatures)
      .where(eq(webhook_event_signatures.event_signature, eventSignature));
    expect(claim?.webhook_event_id).toBe(result.event?.id);
  });

  test('reports a redelivery as a duplicate without storing it again', async () => {
    const eventSignature = `delivery-${crypto.randomUUID()}`;

    await logWebhookEvent(eventInput(user.id, eventSignature));
    const redelivery = await logWebhookEvent(eventInput(user.id, eventSignature));

    expect(redelivery).toEqual({ isDuplicate: true });
    const stored = await db
      .select({ id: webhook_events_v2.id })
      .from(webhook_events_v2)
      .where(eq(webhook_events_v2.event_signature, eventSignature));
    expect(stored).toHaveLength(1);
  });

  test('stores one event when the same delivery arrives concurrently', async () => {
    const eventSignature = `delivery-${crypto.randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 4 }, () => logWebhookEvent(eventInput(user.id, eventSignature)))
    );

    expect(results.filter(result => !result.isDuplicate)).toHaveLength(1);
    const stored = await db
      .select({ id: webhook_events_v2.id })
      .from(webhook_events_v2)
      .where(eq(webhook_events_v2.event_signature, eventSignature));
    expect(stored).toHaveLength(1);
  });

  test('treats a delivery already in the pre-partitioning table as a duplicate', async () => {
    const eventSignature = `delivery-${crypto.randomUUID()}`;
    await db.insert(webhook_events).values({
      owned_by_user_id: user.id,
      platform: 'github',
      event_type: 'pull_request',
      payload: {},
      headers: {},
      event_signature: eventSignature,
    });

    const result = await logWebhookEvent(eventInput(user.id, eventSignature));

    expect(result).toEqual({ isDuplicate: true });
    const stored = await db
      .select({ id: webhook_events_v2.id })
      .from(webhook_events_v2)
      .where(eq(webhook_events_v2.event_signature, eventSignature));
    expect(stored).toHaveLength(0);
  });

  test('releases the claim when the event insert fails, so a retry is stored', async () => {
    const eventSignature = `delivery-${crypto.randomUUID()}`;
    const invalidEvent = { ...eventInput(user.id, eventSignature), platform: null as never };

    await expect(logWebhookEvent(invalidEvent)).rejects.toThrow();
    const claims = await db
      .select()
      .from(webhook_event_signatures)
      .where(eq(webhook_event_signatures.event_signature, eventSignature));
    expect(claims).toHaveLength(0);

    const retry = await logWebhookEvent(eventInput(user.id, eventSignature));
    expect(retry.isDuplicate).toBe(false);
  });
});

describe('logWebhookEvent without a partition for today', () => {
  let user: User;

  beforeEach(async () => {
    user = await insertTestUser();
  });

  afterEach(async () => {
    await cleanupDbForTest();
    await provisionWebhookEventPartitions(db);
  });

  test('creates the missing partition and stores the event', async () => {
    // Where no cron keeps partitions ahead, such as local development.
    const today = webhookEventPartitionName(new Date());
    await db.execute(sql.raw(`ALTER TABLE webhook_events_v2 DETACH PARTITION ${today}`));
    await db.execute(sql.raw(`DROP TABLE ${today}`));
    const eventSignature = `delivery-${crypto.randomUUID()}`;

    const result = await logWebhookEvent(eventInput(user.id, eventSignature));

    expect(result.isDuplicate).toBe(false);
    const stored = await findEventBySignature(eventSignature);
    expect(stored.id).toBe(result.event?.id);
  });
});

describe('updateWebhookEvent', () => {
  let user: User;

  beforeEach(async () => {
    user = await insertTestUser();
  });

  afterEach(cleanupDbForTest);

  test('marks the event processed through the identity logWebhookEvent returned', async () => {
    const eventSignature = `delivery-${crypto.randomUUID()}`;
    const { event } = await logWebhookEvent(eventInput(user.id, eventSignature));
    if (!event) throw new Error('expected a stored event');

    await updateWebhookEvent(event, {
      processed: true,
      processed_at: '2026-11-19T10:00:00.000Z',
      handlers_triggered: ['code_review'],
      errors: null,
    });

    const stored = await findEventBySignature(eventSignature);
    expect(stored.processed).toBe(true);
    expect(stored.handlers_triggered).toEqual(['code_review']);
  });
});
