import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { allocation, routes } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { env, evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { awsProviderFixture } from '../fixtures/aws-provider.js';
import { awsOperationStorage } from '../../src/control-plane/sandbox/aws-operation-storage.js';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';

const namespace = (env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> })
  .SANDBOX_CONTROL;
afterEach(async () => {
  await reset();
});

describe('AWS durable launch checkpoint', () => {
  it.each([403, 503])(
    'keeps AWS failure %s semantics through the real DO alarm and route state',
    async status => {
      const sandboxId = `sbx_aws_failure_${status}`;
      const fixture = awsProviderFixture(sandboxId);
      fixture.setNow(Date.now());
      const stub = namespace.getByName(sandboxId);
      await runInDurableObject(stub, async (instance, state) => {
        await instance.getAllocationState();
        const adapter = fixture.adapter(awsOperationStorage(state.storage));
        const allocationId = '11111111-1111-4111-8111-111111111111';
        const created = await adapter.create({ intentId: allocationId, createdAt: 10_000 });
        if (!('providerRef' in created)) throw new Error('Missing provider reference');
        fixture.loseNextReply();
        await expect(
          adapter.launch(created.providerRef, {
            command: { argv: ['/bin/true'] },
            env: {},
          })
        ).rejects.toThrow('TransportError');
        fixture.failRuntime(
          new AwsRequestError(
            status,
            status === 403 ? 'AccessDeniedException' : 'InternalServerException'
          )
        );
        Object.assign(instance, { provider: adapter });
        const db = drizzle(state.storage, { logger: false });
        await db
          .update(allocation)
          .set({
            state: 'starting',
            allocation_id: allocationId,
            provider_ref: created.providerRef,
            stop_attempt: 0,
            stop_pending: false,
            first_connect_deadline_at: Date.now() + 60_000,
          })
          .where(eq(allocation.id, 'current'));
        const sessionId = 'workspace_11111111-1111-4111-8111-111111111111';
        await db.insert(routes).values({
          session_id: sessionId,
          spec: JSON.stringify({
            sessionId,
            kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
            directory: '/workspace/project',
            attemptId: 'attempt-1',
          }),
          state: 'preparing',
          attempt_id: 'attempt-1',
          attempt_deadline_at: Date.now() + 60_000,
          updated_at: Date.now(),
        });
        await instance.alarm();
        const [route] = await db.select().from(routes);
        expect(route).toMatchObject(
          status === 403
            ? { state: 'failed', reason: 'byoc_aws_forbidden' }
            : { state: 'preparing', reason: null }
        );
        expect((await instance.getAllocationState()).kind).toBe(
          status === 403 ? 'stopping' : 'starting'
        );
      });
      expect(fixture.vms.size).toBe(1);
    }
  );

  it('replays an exact lost response after eviction using the persisted request and credential', async () => {
    const sandboxId = 'sbx_aws_durable_launch';
    const fixture = awsProviderFixture(sandboxId);
    const stub = namespace.getByName(sandboxId);
    const ref = await runInDurableObject(stub, async (instance, state) => {
      await instance.getAllocationState();
      const adapter = fixture.adapter(awsOperationStorage(state.storage));
      const created = await adapter.create({ intentId: 'durable-1', createdAt: 10_000 });
      if (!('providerRef' in created)) throw new Error('Missing provider reference');
      fixture.loseNextReply();
      await expect(
        adapter.launch(created.providerRef, {
          command: { argv: ['/bin/true'] },
          env: { SANDBOX_CONTROL_CREDENTIAL: 'original-credential' },
        })
      ).rejects.toThrow('TransportError');
      return created.providerRef;
    });
    expect(fixture.vms.size).toBe(1);
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.getAllocationState();
      const adapter = fixture.adapter(awsOperationStorage(state.storage));
      await adapter.reconcileLaunch(ref);
      expect(fixture.submitted).toHaveLength(2);
      expect(fixture.submitted[1]).toEqual(fixture.submitted[0]);
      expect(fixture.signedUrls()).toBe(1);
      expect(fixture.launchedDocument().env.SANDBOX_CONTROL_CREDENTIAL).toBe('original-credential');
      expect(await adapter.stop(ref)).toBe('terminal');
    });
    expect(fixture.vms.size).toBe(1);
    expect([...fixture.vms.values()][0]?.current.state).toBe('TERMINATED');
  });
});
