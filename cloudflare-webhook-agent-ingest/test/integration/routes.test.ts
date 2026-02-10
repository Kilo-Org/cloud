import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { encodeUserIdForPath } from '../../src/util/user-id-encoding';

describe('Hono Routes', () => {
  describe('Webhook Ingestion - Personal Triggers', () => {
    const testUserId = 'user123';
    const testTriggerId = 'test-trigger';
    const namespace = `user/${testUserId}`;

    it('should return 404 for unconfigured personal trigger', async () => {
      const response = await SELF.fetch(`http://localhost/inbound/user/unconfigured/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true }),
      });

      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Trigger not found');
    });

    it('should capture webhook for configured personal trigger', async () => {
      // First configure the trigger via DO
      const id = env.TRIGGER_DO.idFromName(`${namespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);
      await stub.configure(namespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      // Now send webhook
      const response = await SELF.fetch(
        `http://localhost/inbound/user/${testUserId}/${testTriggerId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Custom-Header': 'test-value',
          },
          body: JSON.stringify({ event: 'test', data: { foo: 'bar' } }),
        }
      );

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.requestId).toBeDefined();
      expect(body.data.message).toBe('Webhook captured successfully');
    });

    it('should return 413 for payload exceeding 256KB', async () => {
      const id = env.TRIGGER_DO.idFromName(`${namespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);
      await stub.configure(namespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const largeBody = 'x'.repeat(256 * 1024 + 1);
      const response = await SELF.fetch(
        `http://localhost/inbound/user/${testUserId}/${testTriggerId}`,
        {
          method: 'POST',
          body: largeBody,
        }
      );

      expect(response.status).toBe(413);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Payload too large');
    });

    it('should return 415 for unsupported content type', async () => {
      const id = env.TRIGGER_DO.idFromName(`${namespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);
      await stub.configure(namespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const response = await SELF.fetch(
        `http://localhost/inbound/user/${testUserId}/${testTriggerId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'multipart/form-data; boundary=----test',
          },
          body: '----test',
        }
      );

      expect(response.status).toBe(415);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Unsupported content type');
    });

    it('should return 429 when too many requests are in flight', async () => {
      const id = env.TRIGGER_DO.idFromName(`${namespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);
      await stub.configure(namespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      for (let i = 0; i < 20; i++) {
        const result = await stub.captureRequest({
          method: 'POST',
          path: `/webhook-${i}`,
          queryString: null,
          headers: {},
          body: `body-${i}`,
          contentType: null,
          sourceIp: null,
        });
        expect(result.success).toBe(true);
      }

      const response = await SELF.fetch(
        `http://localhost/inbound/user/${testUserId}/${testTriggerId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'overflow' }),
        }
      );

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Too many in-flight requests');
    });
  });

  describe('Webhook Ingestion - OAuth User ID (encoded)', () => {
    const oauthUserId = 'oauth/google:101043560986948156510';
    const encodedUserId = encodeUserIdForPath(oauthUserId);
    const testTriggerId = 'oauth-trigger';
    // The namespace uses the raw (decoded) userId internally
    const namespace = `user/${oauthUserId}`;

    it('should capture webhook for an OAuth user via encoded path', async () => {
      const id = env.TRIGGER_DO.idFromName(`${namespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);
      await stub.configure(namespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      // Use the encoded userId in the URL path
      const response = await SELF.fetch(
        `http://localhost/inbound/user/${encodedUserId}/${testTriggerId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'oauth-test' }),
        }
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.requestId).toBeDefined();
    });

    it('should return 404 for unconfigured OAuth user trigger', async () => {
      const unknownEncoded = encodeUserIdForPath('oauth/google:999999999');
      const response = await SELF.fetch(
        `http://localhost/inbound/user/${unknownEncoded}/unknown-trigger`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ test: true }),
        }
      );

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.success).toBe(false);
    });
  });

  describe('Webhook Ingestion - Organization Triggers', () => {
    const testOrgId = 'org456';
    const testTriggerId = 'org-trigger';
    const namespace = `org/${testOrgId}`;

    it('should return 404 for unconfigured org trigger', async () => {
      const response = await SELF.fetch(`http://localhost/inbound/org/unconfigured/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true }),
      });

      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Trigger not found');
    });

    it('should capture webhook for configured org trigger', async () => {
      // First configure the trigger via DO
      const id = env.TRIGGER_DO.idFromName(`${namespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);
      await stub.configure(namespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      // Now send webhook
      const response = await SELF.fetch(
        `http://localhost/inbound/org/${testOrgId}/${testTriggerId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'push',
          },
          body: JSON.stringify({ ref: 'refs/heads/main' }),
        }
      );

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.requestId).toBeDefined();
      expect(body.data.message).toBe('Webhook captured successfully');
    });
  });
});
