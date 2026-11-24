import { env, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ecsProviderFixture } from '../fixtures/aws-ecs.js';
import { awsEcsOperationStorage } from '../../src/control-plane/sandbox/aws-operation-storage.js';
import { allocation } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { hashSandboxCredential } from '../../src/sandbox-control/credential.js';
import { CONTROL_PLANE_PROTOCOL_VERSION } from '../../src/shared/control-plane-protocol.js';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';

const namespace = (env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> })
  .SANDBOX_CONTROL;
const allocationId = '11111111-1111-4111-8111-111111111111';
const credential = 'a'.repeat(64);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release };
}
function socket(state: DurableObjectState) {
  const pair = new WebSocketPair();
  state.acceptWebSocket(pair[1]);
  pair[0].accept();
  pair[1].serializeAttachment({
    credential,
    allocationId,
    runtimeCapability: 'worktree',
    helloDeadlineAt: Date.now() + 60_000,
  });
  const messages: string[] = [];
  pair[0].addEventListener('message', event => {
    messages.push(String(event.data));
  });
  return { client: pair[0], server: pair[1], messages };
}
function hello(wrapperId: string) {
  return JSON.stringify({
    type: 'hello',
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    allocationId,
    wrapperId,
  });
}
async function setup(instance: SandboxControlV2, state: DurableObjectState, sandboxId: string) {
  await instance.getAllocationState();
  const fixture = ecsProviderFixture(sandboxId);
  fixture.setNow(Date.now());
  const adapter = fixture.adapter(awsEcsOperationStorage(state.storage));
  const created = await adapter.create({ intentId: allocationId, createdAt: Date.now() });
  if (!('providerRef' in created)) throw new Error('Missing provider reference');
  fixture.loseNextReply();
  await expect(
    adapter.launch(created.providerRef, { command: { argv: ['/bin/true'] }, env: {} })
  ).rejects.toThrow('TransportError');
  Object.assign(instance, { provider: adapter });
  await state.storage.put('wrapper_credential_hash', await hashSandboxCredential(credential));
  const db = drizzle(state.storage, { logger: false });
  await db
    .update(allocation)
    .set({
      state: 'starting',
      allocation_id: allocationId,
      provider_ref: created.providerRef,
      first_connect_deadline_at: Date.now() + 60_000,
    })
    .where(eq(allocation.id, 'current'));
  return fixture;
}
afterEach(() => reset());

describe('AWS first hello concurrency', () => {
  it('keeps Stop responsive during validation and never binds its late result', async () => {
    const sandboxId = 'sbx_aws_hello_stop';
    await runInDurableObject(namespace.getByName(sandboxId), async (instance, state) => {
      const fixture = await setup(instance, state, sandboxId);
      const waiting = gate();
      fixture.gateRun(waiting.promise);
      const peer = socket(state);
      const pendingHello = instance.webSocketMessage(peer.server, hello('wr_first'));
      try {
        await vi.waitFor(() => expect(fixture.submitted).toHaveLength(2));
        const stop = instance.cancelWorkspace({
          sessionId: 'ses_aws_hello_stop',
          requestedAt: Date.now(),
        });
        const result = await Promise.race([
          stop.then(() => 'stopped'),
          new Promise(resolve => setTimeout(() => resolve('blocked'), 1_000)),
        ]);
        expect(result).toBe('stopped');
        expect((await instance.getAllocationState()).kind).toBe('stopping');
      } finally {
        waiting.release();
        await pendingHello;
      }
      expect(['stopping', 'stopped']).toContain((await instance.getAllocationState()).kind);
      expect(peer.server.deserializeAttachment()).not.toHaveProperty('connectionId');
      expect(peer.messages.some(message => JSON.parse(message).type === 'welcome')).toBe(false);
      peer.client.close();
    });
  });

  it('rejects a credential revoked while validation is pending', async () => {
    const sandboxId = 'sbx_aws_hello_revoked';
    await runInDurableObject(namespace.getByName(sandboxId), async (instance, state) => {
      const fixture = await setup(instance, state, sandboxId);
      const waiting = gate();
      fixture.gateRun(waiting.promise);
      const peer = socket(state);
      const pendingHello = instance.webSocketMessage(peer.server, hello('wr_revoked'));
      try {
        await vi.waitFor(() => expect(fixture.submitted).toHaveLength(2));
        await state.storage.put(
          'wrapper_credential_hash',
          await hashSandboxCredential('b'.repeat(64))
        );
      } finally {
        waiting.release();
        await pendingHello;
      }
      expect((await instance.getAllocationState()).kind).toBe('starting');
      expect(peer.server.deserializeAttachment()).not.toHaveProperty('connectionId');
      expect(peer.messages.some(message => JSON.parse(message).type === 'welcome')).toBe(false);
      peer.client.close();
    });
  });

  it('preserves a newer connection when an earlier validation completes late', async () => {
    const sandboxId = 'sbx_aws_hello_replaced';
    await runInDurableObject(namespace.getByName(sandboxId), async (instance, state) => {
      const fixture = await setup(instance, state, sandboxId);
      const waiting = gate();
      fixture.gateRun(waiting.promise);
      const first = socket(state);
      const pendingHello = instance.webSocketMessage(first.server, hello('wr_first'));
      let connectionId: string | null = null;
      const second = socket(state);
      try {
        await vi.waitFor(() => expect(fixture.submitted).toHaveLength(2));
        // A duplicate on the same socket must not start another provider request.
        await instance.webSocketMessage(first.server, hello('wr_first'));
        expect(fixture.submitted).toHaveLength(2);
        fixture.gateRun(undefined);
        await instance.webSocketMessage(second.server, hello('wr_second'));
        const connected = await instance.getAllocationState();
        expect(connected.kind).toBe('connected');
        expect(connected.wrapperId).toBe('wr_second');
        connectionId = connected.connectionId;
      } finally {
        waiting.release();
        await pendingHello;
      }
      expect(await instance.getAllocationState()).toMatchObject({
        kind: 'connected',
        connectionId,
        wrapperId: 'wr_second',
      });
      expect(first.server.deserializeAttachment()).not.toHaveProperty('connectionId');
      first.client.close();
      second.client.close();
    });
  });
});
