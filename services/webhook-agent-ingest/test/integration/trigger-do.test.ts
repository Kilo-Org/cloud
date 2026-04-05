import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('TriggerDO', () => {
  const testUserId = 'user123';
  const testOrgId = 'org456';
  const testTriggerId = 'test-trigger';
  const testUserNamespace = `user/${testUserId}`;
  const testOrgNamespace = `org/${testOrgId}`;

  describe('configure', () => {
    it('should return config for user namespace', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const config = await stub.getConfig();
      expect(config).toMatchObject({
        triggerId: testTriggerId,
        namespace: testUserNamespace,
        userId: testUserId,
        orgId: null,
        isActive: true,
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });
    });

    it('should return config for org namespace', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testOrgNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testOrgNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const config = await stub.getConfig();
      expect(config).toMatchObject({
        triggerId: testTriggerId,
        namespace: testOrgNamespace,
        userId: null,
        orgId: testOrgId,
        isActive: true,
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });
    });
  });

  describe('isActive', () => {
    it('should return false for unconfigured trigger', async () => {
      const id = env.TRIGGER_DO.idFromName('unconfigured/trigger');
      const stub = env.TRIGGER_DO.get(id);

      const isActive = await stub.isActive();

      expect(isActive).toBe(false);
    });

    it('should return true for configured trigger', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });
      const isActive = await stub.isActive();

      expect(isActive).toBe(true);
    });
  });

  describe('captureRequest', () => {
    it('should fail for unconfigured trigger', async () => {
      const id = env.TRIGGER_DO.idFromName('unconfigured/trigger');
      const stub = env.TRIGGER_DO.get(id);

      const result = await stub.captureRequest({
        method: 'POST',
        path: '/webhook',
        queryString: null,
        headers: { 'content-type': 'application/json' },
        body: '{"test": true}',
        contentType: 'application/json',
        sourceIp: '127.0.0.1',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Trigger not configured or inactive');
    });

    it('should capture and store request for configured trigger', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const result = await stub.captureRequest({
        method: 'POST',
        path: '/webhook',
        queryString: null,
        headers: { 'content-type': 'application/json' },
        body: '{"test": true}',
        contentType: 'application/json',
        sourceIp: '127.0.0.1',
      });

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error('Expected captureRequest to succeed');
      }
      expect(result.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      const request = await stub.getRequest(result.requestId);

      expect(request).toBeDefined();
      if (!request) {
        throw new Error('Expected request to be defined');
      }
      expect(request.method).toBe('POST');
      expect(request.path).toBe('/webhook');
      expect(request.body).toBe('{"test": true}');
      expect(request.processStatus).toBe('captured');
    });

    it('should reject payload exceeding 256KB', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const largeBody = 'x'.repeat(256 * 1024 + 1);
      const result = await stub.captureRequest({
        method: 'POST',
        path: '/webhook',
        queryString: null,
        headers: {},
        body: largeBody,
        contentType: null,
        sourceIp: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Payload too large');
    });

    it('should reject when too many requests are in flight', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
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

      const overflow = await stub.captureRequest({
        method: 'POST',
        path: '/webhook-overflow',
        queryString: null,
        headers: {},
        body: 'overflow',
        contentType: null,
        sourceIp: null,
      });

      expect(overflow.success).toBe(false);
      expect(overflow.error).toBe('Too many in-flight requests');
    });
  });

  describe('listRequests', () => {
    it('should return empty array for new trigger', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const result = await stub.listRequests();

      expect(result.requests).toEqual([]);
    });

    it('should return captured requests in reverse chronological order', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      // Capture multiple requests with a small delay to ensure different timestamps
      await stub.captureRequest({
        method: 'POST',
        path: '/first',
        queryString: null,
        headers: {},
        body: 'first',
        contentType: null,
        sourceIp: null,
      });

      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      await stub.captureRequest({
        method: 'POST',
        path: '/second',
        queryString: null,
        headers: {},
        body: 'second',
        contentType: null,
        sourceIp: null,
      });

      const result = await stub.listRequests();

      expect(result.requests.length).toBe(2);
      expect(result.requests[0].path).toBe('/second');
      expect(result.requests[1].path).toBe('/first');
    });
  });

  describe('getRequest', () => {
    it('should return null for non-existent request', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const request = await stub.getRequest('non-existent-id');

      expect(request).toBeNull();
    });

    it('should return request with parsed headers', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const captureResult = await stub.captureRequest({
        method: 'POST',
        path: '/webhook',
        queryString: null,
        headers: { 'x-custom': 'value', 'content-type': 'application/json' },
        body: '{}',
        contentType: 'application/json',
        sourceIp: '10.0.0.1',
      });

      expect(captureResult.success).toBe(true);
      if (!captureResult.success) {
        throw new Error('Expected captureRequest to succeed');
      }

      const request = await stub.getRequest(captureResult.requestId);

      expect(request).toBeDefined();
      if (!request) {
        throw new Error('Expected request to be defined');
      }
      expect(request.headers).toEqual({
        'x-custom': 'value',
        'content-type': 'application/json',
      });
      expect(request.sourceIp).toBe('10.0.0.1');
    });
  });

  describe('updateRequest', () => {
    it('should update status, timestamps, and session id', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      const captureResult = await stub.captureRequest({
        method: 'POST',
        path: '/webhook',
        queryString: null,
        headers: {},
        body: '{}',
        contentType: null,
        sourceIp: null,
      });

      expect(captureResult.success).toBe(true);
      if (!captureResult.success) {
        throw new Error('Expected captureRequest to succeed');
      }

      await stub.updateRequest(captureResult.requestId, {
        process_status: 'inprogress',
        started_at: '2024-01-01T00:00:00Z',
        cloud_agent_session_id: 'session-123',
      });

      const request = await stub.getRequest(captureResult.requestId);

      expect(request).toBeDefined();
      if (!request) {
        throw new Error('Expected request to be defined');
      }
      expect(request.processStatus).toBe('inprogress');
      expect(request.startedAt).toBe('2024-01-01T00:00:00Z');
      expect(request.cloudAgentSessionId).toBe('session-123');
    });
  });

  describe('deleteTrigger', () => {
    it('should delete all trigger data', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${testTriggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, testTriggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      await stub.captureRequest({
        method: 'POST',
        path: '/webhook',
        queryString: null,
        headers: {},
        body: '{}',
        contentType: null,
        sourceIp: null,
      });

      const result = await stub.deleteTrigger();

      expect(result.success).toBe(true);

      // Verify trigger is no longer active
      const isActive = await stub.isActive();
      expect(isActive).toBe(false);
    });
  });
});
