import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, it, expect } from 'vitest';
import { triggerConfig } from '../../src/db/sqlite-schema';
import type { TriggerDO } from '../../src/dos/TriggerDO';

async function expectSandboxAllocation(
  stub: DurableObjectStub<TriggerDO>,
  sandboxAllocation: 'isolated-standard' | undefined
): Promise<void> {
  expect((await stub.getConfig())?.sandboxAllocation).toBe(sandboxAllocation);
  expect((await stub.getConfigForResponse())?.sandboxAllocation).toBe(sandboxAllocation);
  await runInDurableObject(stub, async (_instance, state) => {
    const config = await state.storage.get<{ sandboxAllocation?: 'isolated-standard' }>('config');
    expect(config?.sandboxAllocation).toBe(sandboxAllocation);
    const row = drizzle(state.storage)
      .select({ sandboxAllocation: triggerConfig.sandbox_allocation })
      .from(triggerConfig)
      .get();
    expect(row?.sandboxAllocation).toBe(sandboxAllocation ?? null);
  });
}

describe('TriggerDO', () => {
  const testUserId = 'user123';
  const testOrgId = 'org456';
  const testTriggerId = 'test-trigger';
  const testUserNamespace = `user/${testUserId}`;
  const testOrgNamespace = `org/${testOrgId}`;

  describe('configure', () => {
    it.each([
      ['webhook', undefined],
      ['scheduled', '* * * * *'],
    ] as const)(
      'persists sandbox allocation for %s triggers independently from KV hydration',
      async (activationMode, cronExpression) => {
        const triggerId = `sandbox-allocation-${activationMode}`;
        const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${triggerId}`);
        const stub = env.TRIGGER_DO.get(id);

        await stub.configure(testUserNamespace, triggerId, {
          githubRepo: 'owner/repo',
          mode: 'code',
          model: 'openai/gpt-4.1',
          promptTemplate: 'Process {{body}}',
          sandboxAllocation: 'isolated-standard',
          activationMode,
          cronExpression,
        });

        await runInDurableObject(stub, async (_instance, state) => {
          const config = await state.storage.get<{ sandboxAllocation?: 'isolated-standard' }>(
            'config'
          );
          expect(config?.sandboxAllocation).toBe('isolated-standard');
          const row = drizzle(state.storage)
            .select({ sandboxAllocation: triggerConfig.sandbox_allocation })
            .from(triggerConfig)
            .get();
          expect(row?.sandboxAllocation).toBe('isolated-standard');
          await state.storage.delete('config');
        });

        expect((await stub.getConfig())?.sandboxAllocation).toBe('isolated-standard');
      }
    );

    it.each([
      ['webhook', undefined],
      ['scheduled', '* * * * *'],
    ] as const)(
      'updates, preserves, and clears sandbox allocation in SQLite and KV for %s triggers',
      async (activationMode, cronExpression) => {
        const triggerId = `sandbox-allocation-update-${activationMode}`;
        const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${triggerId}`);
        const stub = env.TRIGGER_DO.get(id);

        await stub.configure(testUserNamespace, triggerId, {
          githubRepo: 'owner/repo',
          mode: 'code',
          model: 'openai/gpt-4.1',
          promptTemplate: 'Process {{body}}',
          activationMode,
          cronExpression,
        });
        await stub.updateConfig({ sandboxAllocation: 'isolated-standard' });
        await expectSandboxAllocation(stub, 'isolated-standard');

        await stub.updateConfig({ promptTemplate: 'Updated {{body}}' });
        await expectSandboxAllocation(stub, 'isolated-standard');

        await stub.updateConfig({ sandboxAllocation: undefined });
        await expectSandboxAllocation(stub, 'isolated-standard');

        await stub.updateConfig({ sandboxAllocation: null });
        await expectSandboxAllocation(stub, undefined);
      }
    );

    it('hydrates an existing SQLite row with a null sandbox allocation', async () => {
      const triggerId = 'sandbox-allocation-legacy';
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${triggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await runInDurableObject(stub, async (_instance, state) => {
        drizzle(state.storage)
          .insert(triggerConfig)
          .values({
            trigger_id: triggerId,
            namespace: testUserNamespace,
            user_id: testUserId,
            org_id: null,
            created_at: '2026-01-01T00:00:00.000Z',
            is_active: 1,
            target_type: 'cloud_agent',
            github_repo: 'owner/repo',
            prompt_template: 'Process {{body}}',
            activation_mode: 'webhook',
          })
          .run();
      });

      expect((await stub.getConfig())?.sandboxAllocation).toBeUndefined();
    });

    it('rejects an invalid persisted sandbox allocation', async () => {
      const triggerId = 'sandbox-allocation-invalid';
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/${triggerId}`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, triggerId, {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process {{body}}',
      });
      await runInDurableObject(stub, async (_instance, state) => {
        drizzle(state.storage).update(triggerConfig).set({ sandbox_allocation: 'invalid' }).run();
      });

      await runInDurableObject(stub, async instance => {
        await expect(instance.getConfig()).rejects.toThrow();
      });
    });

    it('rejects sandbox allocation for KiloClaw without mutating it or normal configs', async () => {
      const kiloclawId = env.TRIGGER_DO.idFromName(
        `${testUserNamespace}/sandbox-allocation-kiloclaw`
      );
      const normalId = env.TRIGGER_DO.idFromName(`${testUserNamespace}/sandbox-allocation-normal`);
      const kiloclawStub = env.TRIGGER_DO.get(kiloclawId);
      const normalStub = env.TRIGGER_DO.get(normalId);
      const baseConfig = {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process {{body}}',
      };

      await runInDurableObject(kiloclawStub, async (instance, state) => {
        await expect(
          instance.configure(testUserNamespace, 'sandbox-allocation-kiloclaw', {
            ...baseConfig,
            targetType: 'kiloclaw_chat',
            sandboxAllocation: 'isolated-standard',
          })
        ).rejects.toThrow('Sandbox allocation is only supported for cloud agent triggers');
        expect(await instance.getConfig()).toBeNull();
        expect(await state.storage.get('config')).toBeUndefined();
      });

      await kiloclawStub.configure(testUserNamespace, 'sandbox-allocation-kiloclaw', {
        ...baseConfig,
        targetType: 'kiloclaw_chat',
      });
      await normalStub.configure(testUserNamespace, 'sandbox-allocation-normal', {
        ...baseConfig,
        sandboxAllocation: 'isolated-standard',
      });
      const before = await kiloclawStub.getConfig();

      await runInDurableObject(kiloclawStub, async instance => {
        await expect(
          instance.updateConfig({ sandboxAllocation: 'isolated-standard' })
        ).rejects.toThrow('Sandbox allocation is only supported for cloud agent triggers');
        await expect(instance.updateConfig({ sandboxAllocation: null })).rejects.toThrow(
          'Sandbox allocation is only supported for cloud agent triggers'
        );
      });
      expect(await kiloclawStub.getConfig()).toEqual(before);
      await expectSandboxAllocation(kiloclawStub, undefined);

      await expect(
        kiloclawStub.updateConfig({ promptTemplate: 'Updated {{body}}' })
      ).resolves.toEqual({ success: true });
      expect(await kiloclawStub.getConfig()).toMatchObject({
        ...before,
        promptTemplate: 'Updated {{body}}',
      });
      await expectSandboxAllocation(normalStub, 'isolated-standard');
    });

    it('round-trips an omitted variant as undefined', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/variant-omitted`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, 'variant-omitted', {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      expect((await stub.getConfig())?.variant).toBeUndefined();
      await runInDurableObject(stub, async (_instance, state) => {
        const row = drizzle(state.storage)
          .select({ variant: triggerConfig.variant })
          .from(triggerConfig)
          .get();
        expect(row?.variant).toBeNull();
      });
    });

    it('round-trips a configured variant and clears it on update', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/variant-set`);
      const stub = env.TRIGGER_DO.get(id);

      await stub.configure(testUserNamespace, 'variant-set', {
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        variant: 'high',
        promptTemplate: 'Process this webhook:\n\n{{body}}',
      });

      expect((await stub.getConfig())?.variant).toBe('high');
      await runInDurableObject(stub, async (_instance, state) => {
        const row = drizzle(state.storage)
          .select({ variant: triggerConfig.variant })
          .from(triggerConfig)
          .get();
        expect(row?.variant).toBe('high');
      });
      await stub.updateConfig({ promptTemplate: 'Updated {{body}}' });
      expect((await stub.getConfig())?.variant).toBe('high');
      await runInDurableObject(stub, async (_instance, state) => {
        const row = drizzle(state.storage)
          .select({ variant: triggerConfig.variant })
          .from(triggerConfig)
          .get();
        expect(row?.variant).toBe('high');
      });
      await stub.updateConfig({ variant: null });
      expect((await stub.getConfig())?.variant).toBeUndefined();
      await runInDurableObject(stub, async (_instance, state) => {
        const row = drizzle(state.storage)
          .select({ variant: triggerConfig.variant })
          .from(triggerConfig)
          .get();
        expect(row?.variant).toBeNull();
      });
    });

    it('preserves existing columns and leaves variant unset for a legacy-shaped row', async () => {
      const id = env.TRIGGER_DO.idFromName(`${testUserNamespace}/variant-legacy`);
      const stub = env.TRIGGER_DO.get(id);

      await runInDurableObject(stub, async (_instance, state) => {
        drizzle(state.storage)
          .insert(triggerConfig)
          .values({
            trigger_id: 'variant-legacy',
            namespace: testUserNamespace,
            user_id: testUserId,
            org_id: null,
            created_at: '2026-01-01T00:00:00.000Z',
            is_active: 1,
            target_type: 'cloud_agent',
            github_repo: 'owner/repo',
            mode: 'code',
            model: 'openai/gpt-4.1',
            prompt_template: 'Process {{body}}',
            profile_id: 'profile-id',
            auto_commit: 1,
            condense_on_complete: 0,
            activation_mode: 'scheduled',
            cron_expression: '* * * * *',
            cron_timezone: 'UTC',
            last_scheduled_at: '2026-01-01T00:00:00.000Z',
            next_scheduled_at: '2026-01-01T00:01:00.000Z',
          })
          .run();
      });

      await expect(stub.getConfig()).resolves.toMatchObject({
        githubRepo: 'owner/repo',
        mode: 'code',
        model: 'openai/gpt-4.1',
        autoCommit: true,
        condenseOnComplete: false,
        activationMode: 'scheduled',
        cronExpression: '* * * * *',
        cronTimezone: 'UTC',
      });
      expect((await stub.getConfig())?.variant).toBeUndefined();
    });

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
