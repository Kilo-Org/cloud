import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { controlPlaneMessages } from '../../src/control-plane/session/sqlite-schema.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import {
  CONTROL_PLANE_TIMERS,
  resolveControlPlaneTimers,
} from '../../src/shared/control-plane-timers.js';
import type {
  ControlPlaneDeliverResult,
  ControlPlanePromptPayload,
} from '../../src/shared/control-plane-protocol.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';

const sessions = (env as unknown as { SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2> })
  .SANDBOX_SESSION;
const RECOVERY_KEY = 'control_plane_transport_recovery_at';

function prompt(messageId: string): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'prompt', prompt: messageId },
    agent: { mode: 'code', model: 'test/model' },
  };
}

async function installPeer(stub: DurableObjectStub<SandboxSessionV2>, peer: FakeSandboxPeer) {
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => peer;
  });
}

async function setup() {
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const stub = sessions.getByName(sessionId);
  const peer = new FakeSandboxPeer();
  await runInDurableObject(stub, instance => {
    instance.env.CLOUD_AGENT_REPORT_QUEUE = { send: async () => {} } as never;
    instance.env.CALLBACK_QUEUE = { send: async () => {} } as never;
  });
  const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
  const registered = await stub.registerSessionFromMetadata({
    metadata: parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { sessionId, userId: 'user_transport', createdOnPlatform: 'cloud-agent-web' },
      auth: { kiloSessionId, kilocodeToken: 'test-token' },
      agent: { mode: 'code', model: 'test/model' },
      repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
      callback: { target: { url: 'https://callback.test/hook' } },
      workspace: {
        sandboxId: await generateSandboxId('*', undefined, 'user_transport', sessionId),
        sandboxProvider: 'cloudflare',
        branchName: 'kilo/test',
      },
      lifecycle: { version: 1, timestamp: 1 },
    }),
    sandboxSelection: { provider: 'cloudflare' },
  });
  expect(registered).toEqual({ success: true });
  await installPeer(stub, peer);
  return { stub, peer, sessionId };
}

async function rows(stub: DurableObjectStub<SandboxSessionV2>) {
  return runInDurableObject(stub, (_instance, state) =>
    drizzle(state.storage).select().from(controlPlaneMessages)
  );
}

async function recoveryAt(stub: DurableObjectStub<SandboxSessionV2>) {
  return runInDurableObject(stub, (_instance, state) => state.storage.get<number>(RECOVERY_KEY));
}

async function alarmAt(stub: DurableObjectStub<SandboxSessionV2>) {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function recover(stub: DurableObjectStub<SandboxSessionV2>, peer: FakeSandboxPeer) {
  await installPeer(stub, peer);
  await runInDurableObject(stub, async (instance, state) => {
    const dueAt = Date.now() - 1;
    await state.storage.put(RECOVERY_KEY, dueAt);
    Object.assign(instance, { transportRecoveryAt: dueAt });
    await instance.alarm();
  });
}

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, ms = 2_400): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Session operation exceeded transport bound')),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  await reset();
});

describe('SandboxSessionV2 queued transport recovery', () => {
  it('keeps RPC deadlines real and scales only the recovery delay through the existing development override', () => {
    expect(CONTROL_PLANE_TIMERS.session.sandboxRpcDeadlineMs).toBe(2_000);
    expect(CONTROL_PLANE_TIMERS.session.transportRecoveryMs).toBe(15_000);
    const scaled = resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: '10' });
    expect(scaled.session.sandboxRpcDeadlineMs).toBe(2_000);
    expect(scaled.session.transportRecoveryMs).toBe(1_500);
    expect(scaled.sandbox.routePreparationMs).toBe(12 * 60_000);
    expect(resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: 'invalid' })).toBe(
      CONTROL_PLANE_TIMERS
    );
  });
  it('recovers exhausted warm delivery without another send and never replays accepted work', async () => {
    const { stub, peer, sessionId } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(prompt('accepted'));
    peer.deliverError = Object.assign(new Error('retryable transport failure'), {
      retryable: true,
    });
    const before = Date.now();
    await stub.send(prompt('queued'));
    const dueAt = await recoveryAt(stub);
    expect(dueAt).toBeGreaterThanOrEqual(before + 15_000);
    expect(dueAt).toBeLessThanOrEqual(Date.now() + 15_000);
    expect(await alarmAt(stub)).toBe(dueAt);
    const beforeRows = await rows(stub);
    expect(beforeRows.map(row => row.state)).toEqual(['accepted', 'queued']);
    peer.deliverError = null;
    await recover(stub, peer);
    expect((await rows(stub)).map(row => row.state)).toEqual(['accepted', 'accepted']);
    expect(peer.statusCalls).toEqual([sessionId]);
    expect(peer.deliverCalls.at(-1)?.messages).toEqual([prompt('queued')]);
    expect(await recoveryAt(stub)).toBeUndefined();
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'queued' });
    expect((await rows(stub)).map(row => row.state)).toEqual(['completed', 'completed']);
  });

  it('recovers prepare exhaustion with a passive status read before preparation', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = { state: 'unknown' };
    peer.prepareError = new Error('unreachable before preparation');
    await stub.send(prompt('m1'));
    expect(await recoveryAt(stub)).toEqual(expect.any(Number));
    peer.prepareError = null;
    peer.prepare = async input => {
      peer.prepareCalls.push(input);
      return peer.view('preparing');
    };
    await recover(stub, peer);
    expect(peer.statusCalls).toHaveLength(1);
    expect((await rows(stub))[0]?.state).toBe('queued');
    expect(await recoveryAt(stub)).toBeUndefined();
    expect(await alarmAt(stub)).toBe(
      (await rows(stub))[0]!.created_at + CONTROL_PLANE_TIMERS.session.queuedBackstopMs
    );
  });

  it('retires accepted work when not_ready returns a new ready owner, without recursive delivery or replay', async () => {
    const { stub, peer, sessionId } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(prompt('accepted-A'));
    peer.attemptId = 'replacement-B';
    peer.prepareView = peer.view('ready');
    peer.deliverResult = 'not_ready';
    await stub.send(prompt('queued-B'));
    expect((await rows(stub))[0]).toMatchObject({ state: 'failed', reason: 'agent_restarted' });
    expect((await rows(stub))[1]?.state).toBe('queued');
    expect(peer.deliverCalls).toHaveLength(2);
    peer.deliverResult = 'sent';
    await stub.onRoute(peer.view('ready'));
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'queued-B' });
    expect((await rows(stub)).map(row => row.state)).toEqual(['failed', 'completed']);
    expect(
      peer.deliverCalls.filter(call =>
        call.messages.some(message => message.messageId === 'accepted-A')
      )
    ).toHaveLength(1);
    await stub.send(prompt('accepted-A'));
    expect(peer.deliverCalls).toHaveLength(3);
  });

  it('bounds pre-admission confirmation and preserves immutable queued intent when its owner cannot be read', async () => {
    const { stub, peer, sessionId } = await setup();
    await stub.send(prompt('old-A'));
    const oldRow = (await rows(stub))[0];
    const pending = held<Awaited<ReturnType<FakeSandboxPeer['status']>>>();
    peer.status = async () => pending.promise;
    try {
      await bounded(stub.send(prompt('fresh-B')));
      expect((await rows(stub))[0]).toEqual(oldRow);
      expect((await rows(stub))[1]?.state).toBe('queued');
      const dueAt = await recoveryAt(stub);
      expect(dueAt).toEqual(expect.any(Number));
      await stub.stop();
      pending.resolve({ sessionId, view: peer.view('ready') });
      expect((await rows(stub)).map(row => row.state)).toEqual(['cancelled', 'cancelled']);
      expect(await recoveryAt(stub)).toBeUndefined();
    } finally {
      pending.resolve({ sessionId, view: { state: 'unknown' } });
    }
  });

  it('bounds hung deliver, its recovery pass and abort; Stop is durable and late callbacks cannot revive it', async () => {
    const { stub, peer, sessionId } = await setup();
    peer.prepareView = peer.view('ready');
    const delivery = held<ControlPlaneDeliverResult>();
    const abort = held<'sent'>();
    peer.deliver = async payload => {
      peer.deliverCalls.push(payload);
      return delivery.promise;
    };
    peer.abort = async payload => {
      peer.abortCalls.push(payload.sessionId);
      return abort.promise;
    };
    try {
      await bounded(stub.send(prompt('m1')));
      expect((await rows(stub))[0]?.state).toBe('queued');
      await bounded(recover(stub, peer));
      expect(await recoveryAt(stub)).toBeUndefined();
      await bounded(stub.stop());
      const terminal = (await rows(stub))[0];
      expect(terminal?.state).toBe('cancelled');
      expect(await alarmAt(stub)).toBeNull();
      delivery.resolve('sent');
      abort.resolve('sent');
      await stub.onRoute(peer.view('ready'));
      await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
      expect((await rows(stub))[0]).toEqual(terminal);
      expect(peer.deliverCalls).toHaveLength(2);
    } finally {
      delivery.resolve('sent');
      abort.resolve('sent');
    }
  }, 15_000);

  it('lets Stop cancel durably while a deliver and best-effort abort remain held', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    const delivery = held<ControlPlaneDeliverResult>();
    const abort = held<'sent'>();
    peer.deliver = async payload => {
      peer.deliverCalls.push(payload);
      return delivery.promise;
    };
    peer.abort = async () => abort.promise;
    try {
      await runInDurableObject(stub, async instance => {
        const sending = instance.send(prompt('m1'));
        const stopping = instance.stop();
        await bounded(sending);
        await bounded(stopping);
      });
      expect(peer.deliverCalls).toHaveLength(1);
      expect((await rows(stub))[0]?.state).toBe('cancelled');
      expect(await recoveryAt(stub)).toBeUndefined();
    } finally {
      delivery.resolve('sent');
      abort.resolve('sent');
    }
  }, 10_000);

  it.each(['status', 'prepare'] as const)(
    'bounds hung %s in the consumed recovery pass without rearming',
    async operation => {
      const { stub, peer } = await setup();
      peer.prepareError = new Error('unreachable');
      await stub.send(prompt('m1'));
      const pending = held<ReturnType<FakeSandboxPeer['view']>>();
      if (operation === 'status') {
        peer.status = async input => ({ sessionId: input.sessionId, view: await pending.promise });
      } else {
        peer.prepareView = { state: 'unknown' };
        peer.prepare = async () => pending.promise;
      }
      try {
        await bounded(recover(stub, peer));
        expect(await recoveryAt(stub)).toBeUndefined();
        expect((await rows(stub))[0]?.state).toBe('queued');
        expect(await alarmAt(stub)).toBe(
          (await rows(stub))[0]!.created_at + CONTROL_PLANE_TIMERS.session.queuedBackstopMs
        );
      } finally {
        pending.resolve(peer.view('preparing'));
      }
    }
  );

  it('shares one 2 s recovery budget across passive status and delivery', async () => {
    const { stub, peer } = await setup();
    peer.prepareError = new Error('unreachable');
    await stub.send(prompt('m1'));
    const pending = held<ControlPlaneDeliverResult>();
    peer.status = async input => {
      await new Promise(resolve => setTimeout(resolve, 1_200));
      return { sessionId: input.sessionId, view: peer.view('ready') };
    };
    peer.deliver = async payload => {
      peer.deliverCalls.push(payload);
      return pending.promise;
    };
    try {
      await bounded(recover(stub, peer));
      expect(peer.deliverCalls).toHaveLength(1);
      expect((await rows(stub))[0]?.state).toBe('queued');
      expect(await recoveryAt(stub)).toBeUndefined();
    } finally {
      pending.resolve('sent');
    }
  });

  it.each(['preparing', 'reconnecting'] as const)(
    'cancels the recovery obligation when the owner establishes %s',
    async state => {
      const { stub, peer } = await setup();
      peer.prepareError = new Error('unreachable');
      await stub.send(prompt('m1'));
      expect(await recoveryAt(stub)).toEqual(expect.any(Number));
      peer.prepareView = peer.view(state);
      await stub.onRoute(peer.view(state));
      expect(await recoveryAt(stub)).toBeUndefined();
      expect(await alarmAt(stub)).toBe(
        (await rows(stub))[0]!.created_at + CONTROL_PLANE_TIMERS.session.queuedBackstopMs
      );
      expect(peer.deliverCalls).toHaveLength(0);
      expect(peer.statusCalls).toHaveLength(1);
    }
  );

  it.each([
    ['preparing', 'a-new-B'],
    ['ready', 'a-new-B'],
    ['failed', 'a-new-B'],
    ['preparing', 'z-old-A'],
    ['ready', 'z-old-A'],
    ['failed', 'z-old-A'],
  ] as const)(
    'adopts authoritative attempt B %s when %s notifies after a lost prepare response and rejects stale A',
    async (state, notifier) => {
      const { stub, peer } = await setup();
      peer.attemptId = 'z-old-A';
      peer.prepareView = peer.view('preparing');
      await stub.send(prompt('old'));
      peer.prepareView = {
        state: 'failed',
        attemptId: peer.attemptId,
        reason: 'workspace_setup_failed',
      };
      await stub.onRoute({
        state: 'failed',
        attemptId: peer.attemptId,
        reason: 'workspace_setup_failed',
      });
      const old = (await rows(stub))[0];
      peer.attemptId = 'a-new-B';
      peer.prepareView = peer.view('preparing');
      const response = held<ReturnType<FakeSandboxPeer['view']>>();
      peer.prepare = async input => {
        peer.prepareCalls.push(input);
        return response.promise;
      };
      try {
        await bounded(stub.send(prompt('retry')));
        peer.prepareView =
          state === 'failed'
            ? { state, attemptId: peer.attemptId, reason: 'agent_unavailable' }
            : peer.view(state);
        await stub.onRoute(
          notifier === 'z-old-A'
            ? { state: 'failed', attemptId: notifier, reason: 'workspace_setup_failed' }
            : state === 'failed'
              ? { state, attemptId: notifier, reason: 'agent_unavailable' }
              : {
                  state,
                  attemptId: notifier,
                  ...(state === 'preparing' ? { step: 'clone' as const } : {}),
                }
        );
        await expect(stub.getSession()).resolves.toMatchObject({
          route: { state, attemptId: 'a-new-B' },
        });
        if (state === 'preparing' && notifier === 'a-new-B') {
          await expect(stub.getSession()).resolves.toMatchObject({ route: { step: 'clone' } });
        } else if (state === 'preparing') {
          const session = await stub.getSession();
          if (session.type !== 'found') throw new Error('Missing session');
          expect(session.route).toEqual({ state: 'preparing', attemptId: 'a-new-B' });
        }
        expect((await rows(stub))[0]).toEqual(old);
        expect((await rows(stub))[1]?.state).toBe(
          state === 'ready' ? 'accepted' : state === 'failed' ? 'failed' : 'queued'
        );
        if (state === 'failed') expect((await rows(stub))[1]?.reason).toBe('agent_unavailable');
        await stub.onRoute({ state: 'ready', attemptId: 'z-old-A' });
        await stub.onRoute({
          state: 'failed',
          attemptId: 'z-old-A',
          reason: 'workspace_setup_failed',
        });
        await expect(stub.getSession()).resolves.toMatchObject({
          route: { state, attemptId: 'a-new-B' },
        });
        expect(await recoveryAt(stub)).toBeUndefined();
      } finally {
        response.resolve(peer.view('preparing'));
      }
    },
    10_000
  );

  it.each(['state', 'reason'] as const)(
    'does not enrich a confirmed attempt from a notification with mismatched %s',
    async mismatch => {
      const { stub, peer } = await setup();
      await stub.send(prompt('old-A'));
      peer.prepareView = {
        state: 'failed',
        attemptId: peer.attemptId,
        reason: 'workspace_setup_failed',
      };
      await stub.onRoute({
        state: 'failed',
        attemptId: peer.attemptId,
        reason: 'workspace_setup_failed',
      });
      peer.prepareError = new Error('lost response');
      await stub.send(prompt('retry-B'));
      peer.attemptId = 'new-B';
      peer.prepareView =
        mismatch === 'state'
          ? peer.view('ready')
          : { state: 'failed', attemptId: peer.attemptId, reason: 'agent_unavailable' };
      await stub.onRoute(
        mismatch === 'state'
          ? { state: 'preparing', attemptId: peer.attemptId, step: 'clone' }
          : {
              state: 'failed',
              attemptId: peer.attemptId,
              reason: 'workspace_setup_failed',
              subtype: 'git_authentication_failed',
            }
      );
      const session = await stub.getSession();
      if (session.type !== 'found') throw new Error('Missing session');
      expect(session.route).toEqual(peer.prepareView);
      expect((await rows(stub))[1]).toMatchObject(
        mismatch === 'state'
          ? { state: 'accepted', reason: null }
          : { state: 'failed', reason: 'agent_unavailable' }
      );
    }
  );

  it('does not apply old failed A to a fresh queued retry; confirmation failure retains but does not rearm the pass', async () => {
    const { stub, peer } = await setup();
    await stub.send(prompt('old'));
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    };
    await stub.onRoute({
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    });
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    };
    peer.prepareError = new Error('prepare failed before starting B');
    await stub.send(prompt('retry'));
    const dueAt = await recoveryAt(stub);
    await stub.onRoute(peer.prepareView);
    expect((await rows(stub))[1]?.state).toBe('queued');
    expect(await recoveryAt(stub)).toBe(dueAt);
    peer.statusError = new Error('status unavailable');
    await stub.onRoute(peer.view('ready'));
    expect(await recoveryAt(stub)).toBe(dueAt);
    await recover(stub, peer);
    expect(await recoveryAt(stub)).toBeUndefined();
    expect((await rows(stub))[1]?.state).toBe('queued');
    const statusCalls = peer.statusCalls.length;
    await runInDurableObject(stub, instance => instance.alarm());
    expect(peer.statusCalls).toHaveLength(statusCalls);
    expect(await alarmAt(stub)).toBe(
      (await rows(stub))[1]!.created_at + CONTROL_PLANE_TIMERS.session.queuedBackstopMs
    );
    await stub.onRoute({ state: 'ready', attemptId: 'unconfirmed-stale-hint' });
    expect(await recoveryAt(stub)).toBeUndefined();
    await stub.send(prompt('fresh-interaction'));
    expect(await recoveryAt(stub)).toEqual(expect.any(Number));
  });

  it('reconstructs the persisted deadline without moving message backstops', async () => {
    const { stub, peer, sessionId } = await setup();
    peer.prepareError = new Error('unreachable');
    await stub.send(prompt('m1'));
    const original = (await rows(stub))[0];
    const dueAt = await recoveryAt(stub);
    expect(dueAt).toEqual(expect.any(Number));
    await evictAllDurableObjects();
    const revived = sessions.getByName(sessionId);
    await installPeer(revived, peer);
    expect(await recoveryAt(revived)).toBe(dueAt);
    expect(await alarmAt(revived)).toBe(dueAt);
    peer.prepareError = null;
    peer.prepareView = peer.view('ready');
    await runInDurableObject(revived, (_instance, state) =>
      state.storage.put(RECOVERY_KEY, Date.now() - 1)
    );
    await evictAllDurableObjects();
    const reconstructed = sessions.getByName(sessionId);
    await installPeer(reconstructed, peer);
    await runInDurableObject(reconstructed, instance => instance.alarm());
    expect((await rows(reconstructed))[0]).toMatchObject({
      state: 'accepted',
      created_at: original!.created_at,
    });
    expect(await recoveryAt(reconstructed)).toBeUndefined();
  });

  it('permits a fresh recovery opportunity only after status confirms a genuinely new owner hint', async () => {
    const { stub, peer } = await setup();
    await stub.send(prompt('old'));
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    };
    await stub.onRoute({
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
    });
    peer.prepareError = new Error('unreachable');
    await stub.send(prompt('retry'));
    peer.statusError = new Error('unreachable');
    await recover(stub, peer);
    expect(await recoveryAt(stub)).toBeUndefined();
    peer.statusError = null;
    peer.attemptId = 'authoritative-new-B';
    peer.prepareView = peer.view('ready');
    peer.deliverError = new Error('delivery unavailable');
    await stub.onRoute(peer.view('ready'));
    await expect(stub.getSession()).resolves.toMatchObject({
      route: { state: 'ready', attemptId: peer.attemptId },
    });
    expect((await rows(stub))[1]?.state).toBe('queued');
    expect(await recoveryAt(stub)).toEqual(expect.any(Number));
  });

  it.each(['stop', 'cancel', 'delete'] as const)(
    'clears recovery on %s without waking or dispatching and without duplicate terminal effects',
    async action => {
      const { stub, peer } = await setup();
      const reports: unknown[] = [];
      const callbacks: unknown[] = [];
      await runInDurableObject(stub, instance => {
        instance.env.CLOUD_AGENT_REPORT_QUEUE = {
          send: async (report: unknown) => {
            reports.push(report);
          },
        } as never;
        instance.env.CALLBACK_QUEUE = {
          send: async (job: unknown) => {
            callbacks.push(job);
          },
        } as never;
      });
      peer.prepareError = new Error('unreachable');
      await stub.send(prompt('m1'));
      expect(await recoveryAt(stub)).toEqual(expect.any(Number));
      if (action === 'stop') await stub.stop();
      else if (action === 'cancel') await stub.cancelQueuedMessage('m1');
      else await stub.deleteSession();
      const counts = [reports.length, callbacks.length];
      expect(reports).toHaveLength(1);
      expect(callbacks).toHaveLength(1);
      expect(await recoveryAt(stub)).toBeUndefined();
      const prepares = peer.prepareCalls.length;
      await runInDurableObject(stub, instance => instance.alarm());
      expect(peer.prepareCalls).toHaveLength(prepares);
      expect(peer.deliverCalls).toHaveLength(0);
      expect(peer.statusCalls).toHaveLength(0);
      expect([reports.length, callbacks.length]).toEqual(counts);
    }
  );
});
