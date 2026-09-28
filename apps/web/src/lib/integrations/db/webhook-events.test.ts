import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { webhook_events, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { logWebhookEvent } from './webhook-events';

async function findEventBySignature(signature: string) {
  const [event] = await db
    .select()
    .from(webhook_events)
    .where(eq(webhook_events.event_signature, signature));
  if (!event) throw new Error(`webhook_events row ${signature} not found`);
  return event;
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
