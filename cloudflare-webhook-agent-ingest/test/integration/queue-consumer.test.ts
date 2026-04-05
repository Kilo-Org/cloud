import { randomBytes } from 'node:crypto';
import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import type { WebhookDeliveryMessage } from '../../src/util/queue';

describe('Queue Consumer', () => {
  const testUserId = 'user123';
  const testTriggerId = 'queue-test-trigger';
  const namespace = `user/${testUserId}`;

  // Helper to create a queue message
  function createQueueMessage(
    body: WebhookDeliveryMessage
  ): ServiceBindingQueueMessage<WebhookDeliveryMessage> {
    return {
      id: randomBytes(16).toString('hex'),
      timestamp: new Date(),
      attempts: 1,
      body,
    };
  }

  describe('Message Processing', () => {
    it('should handle messages for non-existent request (evicted)', async () => {
      // Configure a trigger but don't capture a request
      const id = env.TRIGGER_DO.idFromName(`${namespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(namespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      // Queue message for non-existent request
      const messages = [
        createQueueMessage({
          namespace,
          triggerId: testTriggerId,
          requestId: 'non-existent-request-id',
        }),
      ];

      // The consumer should ack the message (request was evicted)
      const result = await SELF.queue('webhook-delivery-queue-test', messages);

      expect(result.outcome).toBe('ok');
      expect(result.explicitAcks).toContain(messages[0].id);
      expect(result.retryMessages).toStrictEqual([]);
    });

    it('should skip already processed requests (idempotency)', async () => {
      // Configure trigger and capture a request
      const id = env.TRIGGER_DO.idFromName(`${namespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(namespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const captureResult = await stub.captureRequest({
        method: 'POST',
        path: '/webhook',
        queryString: null,
        headers: { 'content-type': 'application/json' },
        body: '{"test": true}',
        contentType: 'application/json',
        sourceIp: '127.0.0.1',
      });

      expect(captureResult.success).toBe(true);
      if (!captureResult.success) {
        throw new Error('Expected captureRequest to succeed');
      }

      // Manually update the request to 'inprogress' (simulating already processed)
      await stub.updateRequest(captureResult.requestId, {
        process_status: 'inprogress',
        started_at: new Date().toISOString(),
      });

      // Try to process the already-processed request
      const messages = [
        createQueueMessage({
          namespace,
          triggerId: testTriggerId,
          requestId: captureResult.requestId,
        }),
      ];

      const result = await SELF.queue('webhook-delivery-queue-test', messages);

      // Should ack without processing (idempotency)
      expect(result.outcome).toBe('ok');
      expect(result.explicitAcks).toContain(messages[0].id);
      expect(result.retryMessages).toStrictEqual([]);

      // Verify request status didn't change
      const request = await stub.getRequest(captureResult.requestId);
      expect(request?.processStatus).toBe('inprogress');
    });
  });
});
