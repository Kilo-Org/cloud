import { FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN } from './helpers/fake-credentials.js';
import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { controlPlaneMessages, events } from '../../src/control-plane/session/sqlite-schema.js';
import type { HostedGitHubRepositories } from '../../src/persistence/hosted-github-repositories.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { readPreparationAttempt } from '../../src/session/preparation-history.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { worktreeChangesContext } from '../../src/sandbox-session/worktree-changes.js';
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

async function setup(hostedGitHubRepositories?: HostedGitHubRepositories) {
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
      identity: {
        sessionId,
        userId: 'user_transport',
        ...(hostedGitHubRepositories ? { orgId: '123e4567-e89b-42d3-a456-426614174001' } : {}),
        createdOnPlatform: 'cloud-agent-web',
      },
      auth: { kiloSessionId, kilocodeToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN },
      agent: { mode: 'code', model: 'test/model' },
      repository: {
        type: 'github',
        repo: 'acme/widgets',
        upstreamBranch: 'main',
        ...(hostedGitHubRepositories
          ? { githubIntegrationId: hostedGitHubRepositories.integrationId }
          : {}),
      },
      hostedGitHubRepositories,
      callback: { target: { url: 'https://callback.test/hook' } },
      workspace: {
        sandboxId: await generateSandboxId(sessionId),
        sandboxProvider: 'cloudflare-containers',
        ...(hostedGitHubRepositories
          ? {
              worktreeId: 'worktree_123e4567-e89b-42d3-a456-426614174002',
              generatedBranchName: 'kilo/test',
            }
          : {}),
        branchName: hostedGitHubRepositories ? 'main' : 'kilo/test',
      },
      lifecycle: { version: 1, timestamp: 1 },
    }),
    sandboxSelection: { provider: 'cloudflare-containers' },
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

type StoredRecovery = { dueAt: number; since?: number };

async function storedRecovery(
  stub: DurableObjectStub<SandboxSessionV2>
): Promise<StoredRecovery | undefined> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoredRecovery>(RECOVERY_KEY)
  );
}

async function recoveryAt(stub: DurableObjectStub<SandboxSessionV2>) {
  return (await storedRecovery(stub))?.dueAt;
}

async function latestCloudStatus(stub: DurableObjectStub<SandboxSessionV2>) {
  return runInDurableObject(stub, (_instance, state) => {
    const [row] = drizzle(state.storage)
      .select()
      .from(events)
      .where(eq(events.stream_event_type, 'cloud.status'))
      .orderBy(desc(events.id))
      .limit(1)
      .all();
    return row === undefined
      ? undefined
      : (JSON.parse(row.payload) as { cloudStatus: { type: string; message?: string } })
          .cloudStatus;
  });
}

async function alarmAt(stub: DurableObjectStub<SandboxSessionV2>) {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

/** Expects only the slow status check of queued work, armed between two clock reads. */
async function expectStatusCheck(
  stub: DurableObjectStub<SandboxSessionV2>,
  before: number,
  after = Date.now()
) {
  const check = await storedRecovery(stub);
  expect(check).toEqual({ dueAt: expect.any(Number) });
  expect(check!.dueAt).toBeGreaterThanOrEqual(before + 60_000);
  expect(check!.dueAt).toBeLessThanOrEqual(after + 60_000);
  expect(await alarmAt(stub)).toBe(check!.dueAt);
}

/**
 * Moves the stored recovery deadline, and its window start by the same amount,
 * to now and runs the alarm. Returns the moved obligation.
 */
async function recover(
  stub: DurableObjectStub<SandboxSessionV2>,
  peer: FakeSandboxPeer
): Promise<StoredRecovery> {
  await installPeer(stub, peer);
  return runInDurableObject(stub, async (instance, state) => {
    const armed = await state.storage.get<StoredRecovery>(RECOVERY_KEY);
    if (armed === undefined) throw new Error('No transport recovery is armed');
    const shift = armed.dueAt - Date.now() + 1;
    const due =
      armed.since === undefined
        ? { dueAt: armed.dueAt - shift }
        : { dueAt: armed.dueAt - shift, since: armed.since - shift };
    await state.storage.put(RECOVERY_KEY, due);
    Object.assign(instance, { transportRecovery: due });
    await instance.alarm();
    return due;
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
  it('prepares the complete promptless hosted checkout again after an idle stop and eviction', async () => {
    const hosted = {
      integrationId: '123e4567-e89b-42d3-a456-426614174022',
      primary: { id: 101, fullName: 'acme/widgets' },
      additional: [{ id: 102, fullName: 'acme/docs' }],
    };
    const { stub, peer, sessionId } = await setup(hosted);
    expect(await rows(stub)).toEqual([]);
    expect(peer.prepareCalls).toEqual([]);
    const metadata = await stub.getMetadata();
    if (!metadata) throw new Error('Promptless registration did not persist');
    expect(metadata.hostedGitHubRepositories).toEqual(hosted);
    await expect(
      stub.registerSessionFromMetadata({
        metadata: {
          ...metadata,
          hostedGitHubRepositories: { ...hosted, primary: { ...hosted.primary, id: 100 } },
        },
        sandboxSelection: { provider: 'cloudflare-containers' },
      })
    ).resolves.toMatchObject({ success: false });

    peer.prepareView = peer.view('ready');
    await stub.send(prompt('first'));
    const first = peer.prepareCalls.at(-1);
    expect(first).toMatchObject({
      spec: {
        directory: '/workspace',
        roots: [
          { directory: '/workspace/widgets', repoFullName: 'acme/widgets', branch: 'main' },
          {
            directory: '/workspace/docs',
            repoFullName: 'acme/docs',
            branch: 'kilo/test',
            branchMode: 'working',
          },
        ],
      },
      credentials: {
        repository: { hostedRepositoryId: 101, githubIntegrationId: hosted.integrationId },
        additionalHostedGitHubRepositories: hosted.additional,
      },
    });
    expect(first?.environment).toBeUndefined();
    expect(JSON.stringify(first?.spec)).not.toContain(hosted.integrationId);
    expect(worktreeChangesContext(metadata, '/workspace')?.roots).toEqual([
      { directory: '/workspace/widgets', repoFullName: 'acme/widgets', launch: true },
      { directory: '/workspace/docs', repoFullName: 'acme/docs', launch: false },
    ]);
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'first' });
    await stub.onRoute({ state: 'failed', attemptId: peer.attemptId, reason: 'sandbox_stopped' });
    await evictAllDurableObjects();
    const revived = sessions.getByName(sessionId);
    const reallocated = new FakeSandboxPeer();
    reallocated.prepareView = reallocated.view('ready');
    await installPeer(revived, reallocated);
    await revived.send(prompt('after-idle'));
    expect(reallocated.prepareCalls.at(-1)?.spec.roots).toEqual(first?.spec.roots);
    expect(reallocated.prepareCalls.at(-1)?.credentials).toEqual(first?.credentials);
    expect(reallocated.deliverCalls.at(-1)?.messages).toEqual([prompt('after-idle')]);
  });

  it('keeps command text in queued and failed snapshots before acceptance', async () => {
    const { stub, peer } = await setup();
    await stub.send({
      ...prompt('command'),
      turn: { type: 'command', command: 'review', arguments: 'main' },
    });
    expect(await runInDurableObject(stub, instance => instance['deriveQueuedMessages']())).toEqual([
      expect.objectContaining({ messageId: 'command', content: '/review main' }),
    ]);
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'preparation_timeout',
    };
    await stub.onRoute(peer.prepareView);
    await evictAllDurableObjects();
    await installPeer(stub, peer);
    expect(await runInDurableObject(stub, instance => instance['deriveQueuedMessages']())).toEqual([
      expect.objectContaining({
        messageId: 'command',
        content: '/review main',
        terminalFailure: expect.objectContaining({
          accepted: false,
          delivery: 'queued',
          reason: 'preparation_timeout',
        }),
      }),
    ]);
  });

  it('omits accepted command text, including after a runtime failure', async () => {
    const { stub, peer, sessionId } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send({
      ...prompt('command'),
      turn: { type: 'command', command: 'review', arguments: 'main' },
    });
    expect(await runInDurableObject(stub, instance => instance['deriveQueuedMessages']())).toEqual([
      expect.objectContaining({
        messageId: 'command',
        content: '',
        delivery: 'sent',
        turnType: 'command',
      }),
    ]);
    const sent = await runInDurableObject(stub, (_instance, state) =>
      drizzle(state.storage)
        .select()
        .from(events)
        .where(eq(events.stream_event_type, 'cloud.message.sent'))
    );
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.payload)).toMatchObject({
      messageId: 'command',
      turnType: 'command',
    });
    await stub.onOutcome({
      sessionId,
      status: 'failed',
      reason: 'wrapper_failed',
      lastMessageId: 'command',
    });
    expect(await runInDurableObject(stub, instance => instance['deriveQueuedMessages']())).toEqual([
      expect.objectContaining({
        messageId: 'command',
        content: '',
        terminalFailure: expect.objectContaining({ accepted: true }),
      }),
    ]);
  });

  it.each(['completed', 'cancelled'] as const)(
    'retains an accepted %s command receipt after reconstruction without retaining completed prompts',
    async status => {
      const { stub, peer, sessionId } = await setup();
      peer.prepareView = peer.view('ready');
      await stub.send(prompt('ordinary'));
      await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'ordinary' });
      await stub.send({
        ...prompt('command'),
        turn: { type: 'command', command: 'review', arguments: 'main' },
      });
      await stub.onOutcome({
        sessionId,
        status,
        ...(status === 'cancelled' ? { reason: 'interrupted' as const } : {}),
        lastMessageId: 'command',
      });
      await evictAllDurableObjects();
      await installPeer(stub, peer);
      const snapshots = await runInDurableObject(stub, instance =>
        instance['deriveQueuedMessages']()
      );
      expect(snapshots).toEqual([
        expect.objectContaining({
          messageId: 'command',
          content: '',
          ...(status === 'completed'
            ? { completedAt: expect.any(Number) }
            : {
                terminalFailure: expect.objectContaining({ accepted: true, reason: 'interrupted' }),
              }),
        }),
      ]);
      expect(snapshots[0]).not.toHaveProperty('delivery', 'sent');
    }
  );

  it('keeps RPC deadlines real and scales only the recovery delay through the existing development override', () => {
    expect(CONTROL_PLANE_TIMERS.session.sandboxRpcDeadlineMs).toBe(2_000);
    expect(CONTROL_PLANE_TIMERS.session.transportRecoveryMs).toBe(15_000);
    const scaled = resolveControlPlaneTimers({ CONTROL_PLANE_TIMER_DIVISOR: '10' });
    expect(scaled.session.sandboxRpcDeadlineMs).toBe(2_000);
    expect(scaled.session.transportRecoveryMs).toBe(1_500);
    expect(scaled.sandbox.routePreparationMs).toBe(CONTROL_PLANE_TIMERS.sandbox.routePreparationMs);
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
    const before = Date.now();
    await recover(stub, peer);
    expect(peer.statusCalls).toHaveLength(1);
    expect((await rows(stub))[0]?.state).toBe('queued');
    // The window ends; queued work keeps only the slow status check.
    await expectStatusCheck(stub, before);
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

  it('still cancels preparation after the status check exhausts its transport deadline', async () => {
    const { stub, peer, sessionId } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(prompt('m1'));
    const status = held<Awaited<ReturnType<FakeSandboxPeer['status']>>>();
    const snapshot = await peer.status({ sessionId });
    peer.status = async () => status.promise;
    try {
      await bounded(stub.stop());
      expect(peer.cancelWorkspaceCalls).toHaveLength(1);
      expect((await rows(stub))[0]?.state).toBe('cancelled');
    } finally {
      status.resolve(snapshot);
    }
  });

  it.each(['preparing', 'ready'] as const)(
    'rejects an unconfirmed workspace Stop from a %s chat and permits retry',
    async routeState => {
      const { stub, peer } = await setup();
      peer.prepareView = peer.view(routeState);
      await stub.send(prompt('m1'));
      peer.workspacePreparing = true;
      peer.cancelWorkspaceError = new Error('sandbox unavailable');
      const before = await rows(stub);

      await expect(bounded(stub.stop())).rejects.toThrow(
        'Could not stop workspace preparation. Try Stop again.'
      );

      expect(await rows(stub)).toEqual(before);
      await expect(stub.getSession()).resolves.toMatchObject({
        type: 'found',
        route: { state: routeState, attemptId: peer.attemptId },
      });
      expect(await alarmAt(stub)).not.toBeNull();

      peer.cancelWorkspaceError = null;
      await expect(stub.stop()).resolves.toEqual({ interrupted: true });
      expect((await rows(stub))[0]?.state).toBe('cancelled');
      await expect(stub.getSession()).resolves.toMatchObject({
        type: 'found',
        route: { state: 'unknown' },
      });
    }
  );

  it('rejects a workspace Stop without a sandbox peer instead of reporting cancellation', async () => {
    const { stub } = await setup();
    await stub.send(prompt('m1'));
    const before = await rows(stub);
    await runInDurableObject(stub, async instance => {
      instance.sandboxPeerFor = () => null;
      await expect(instance.stop()).rejects.toThrow(
        'Could not stop workspace preparation. Try Stop again.'
      );
    });

    expect(await rows(stub)).toEqual(before);
    await expect(stub.getSession()).resolves.toMatchObject({
      type: 'found',
      route: { state: 'preparing' },
    });
  });

  it('bounds a hung workspace Stop without settling unconfirmed cancellation', async () => {
    const { stub, peer } = await setup();
    await stub.send(prompt('m1'));
    const pending = held<Awaited<ReturnType<FakeSandboxPeer['cancelWorkspace']>>>();
    peer.cancelWorkspace = async () => pending.promise;
    const before = await rows(stub);
    try {
      await expect(bounded(stub.stop())).rejects.toThrow(
        'Could not stop workspace preparation. Try Stop again.'
      );
      expect(await rows(stub)).toEqual(before);
    } finally {
      pending.resolve({ stopEpoch: 1, stopAt: Date.now() });
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
      // The unanswered pass arms the next one; Stop must clear it.
      expect(await recoveryAt(stub)).toEqual(expect.any(Number));
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
    'bounds hung %s in a recovery pass and arms the next pass of the same window',
    async operation => {
      const { stub, peer } = await setup();
      peer.prepareError = new Error('unreachable');
      await stub.send(prompt('m1'));
      const pending = held<ReturnType<FakeSandboxPeer['view']>>();
      if (operation === 'status') {
        peer.status = async input => ({
          sessionId: input.sessionId,
          view: await pending.promise,
          workspacePreparing: false,
          workspaceStopEpoch: 0,
          workspaceStopAt: 0,
        });
      } else {
        peer.prepareView = { state: 'unknown' };
        peer.prepare = async () => pending.promise;
      }
      try {
        const before = Date.now();
        const due = await bounded(recover(stub, peer));
        const next = await storedRecovery(stub);
        expect(next?.since).toBe(due.since);
        expect(next?.dueAt).toBeGreaterThanOrEqual(before + 30_000);
        expect(next?.dueAt).toBeLessThanOrEqual(Date.now() + 30_000);
        expect((await rows(stub))[0]?.state).toBe('queued');
        expect(await alarmAt(stub)).toBe(next?.dueAt);
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
      return {
        sessionId: input.sessionId,
        view: peer.view('ready'),
        workspacePreparing: false,
        workspaceStopEpoch: 0,
        workspaceStopAt: 0,
      };
    };
    peer.deliver = async payload => {
      peer.deliverCalls.push(payload);
      return pending.promise;
    };
    try {
      await bounded(recover(stub, peer));
      expect(peer.deliverCalls).toHaveLength(1);
      expect((await rows(stub))[0]?.state).toBe('queued');
      expect(await recoveryAt(stub)).toEqual(expect.any(Number));
    } finally {
      pending.resolve('sent');
    }
  });

  it.each(['preparing', 'reconnecting'] as const)(
    'ends the recovery window and keeps a slow status check when the owner establishes %s',
    async state => {
      const { stub, peer } = await setup();
      peer.prepareError = new Error('unreachable');
      await stub.send(prompt('m1'));
      expect((await storedRecovery(stub))?.since).toEqual(expect.any(Number));
      peer.prepareView = peer.view(state);
      const before = Date.now();
      await stub.onRoute(peer.view(state));
      await expectStatusCheck(stub, before);
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
        // No recovery window stays open; queued work keeps only the slow status check.
        expect(await storedRecovery(stub)).toEqual(
          state === 'preparing' ? { dueAt: expect.any(Number) } : undefined
        );
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

  it('does not apply old failed A to a fresh queued retry; confirmation failure keeps one recovery window', async () => {
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
    const due = await recover(stub, peer);
    // The unanswered pass arms the next pass of the same window.
    const next = await storedRecovery(stub);
    expect(next).toEqual({ dueAt: expect.any(Number), since: due.since });
    expect((await rows(stub))[1]?.state).toBe('queued');
    const statusCalls = peer.statusCalls.length;
    await runInDurableObject(stub, instance => instance.alarm());
    expect(peer.statusCalls).toHaveLength(statusCalls);
    expect(await alarmAt(stub)).toBe(next?.dueAt);
    // A stale or unconfirmed hint does not move the deadline or the window start.
    await stub.onRoute({ state: 'ready', attemptId: 'unconfirmed-stale-hint' });
    expect(await storedRecovery(stub)).toEqual(next);
    await stub.send(prompt('fresh-interaction'));
    expect(await storedRecovery(stub)).toEqual(next);
  });

  it('reconstructs the persisted deadline without moving message backstops', async () => {
    const { stub, peer, sessionId } = await setup();
    peer.prepareError = new Error('unreachable');
    await stub.send(prompt('m1'));
    const original = (await rows(stub))[0];
    const stored = await storedRecovery(stub);
    expect(stored).toEqual({ dueAt: expect.any(Number), since: expect.any(Number) });
    await evictAllDurableObjects();
    const revived = sessions.getByName(sessionId);
    await installPeer(revived, peer);
    expect(await storedRecovery(revived)).toEqual(stored);
    expect(await alarmAt(revived)).toBe(stored?.dueAt);
    peer.prepareError = null;
    peer.prepareView = peer.view('ready');
    // A deploy before the recovery window stored a bare due time.
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

  it('acts on a new owner hint only after status confirms it, inside the open recovery window', async () => {
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
    const window = await storedRecovery(stub);
    expect(window).toEqual({ dueAt: expect.any(Number), since: expect.any(Number) });
    peer.statusError = null;
    peer.attemptId = 'authoritative-new-B';
    peer.prepareView = peer.view('ready');
    peer.deliverError = new Error('delivery unavailable');
    await stub.onRoute(peer.view('ready'));
    await expect(stub.getSession()).resolves.toMatchObject({
      route: { state: 'ready', attemptId: peer.attemptId },
    });
    expect((await rows(stub))[1]?.state).toBe('queued');
    // The failed delivery stays inside the armed window; it does not restart it.
    expect(await storedRecovery(stub)).toEqual(window);
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
      // Stop asks the sandbox for the authoritative workspace phase; the other
      // settle paths do not need it.
      expect(peer.statusCalls).toHaveLength(action === 'stop' ? 1 : 0);
      expect([reports.length, callbacks.length]).toEqual(counts);
    }
  );
});

describe('SandboxSessionV2 bounded transport recovery', () => {
  const unreachable = () =>
    Object.assign(new Error('Durable Object storage operation exceeded timeout'), {
      retryable: false,
    });

  async function captureQueues(stub: DurableObjectStub<SandboxSessionV2>) {
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
    return { reports, callbacks };
  }

  /** Runs one due recovery pass and checks the delay to the next one. */
  async function expectNextPass(
    stub: DurableObjectStub<SandboxSessionV2>,
    peer: FakeSandboxPeer,
    delayMs: number
  ) {
    const before = Date.now();
    const due = await bounded(recover(stub, peer));
    const after = Date.now();
    const next = await storedRecovery(stub);
    expect(next?.since).toBe(due.since);
    expect(next!.dueAt).toBeGreaterThanOrEqual(before + delayMs);
    expect(next!.dueAt).toBeLessThanOrEqual(after + delayMs);
    expect(await alarmAt(stub)).toBe(next!.dueAt);
  }

  it('re-arms an unanswered recovery pass and prepares again when the sandbox then answers unknown', async () => {
    const { stub, peer } = await setup();
    peer.prepareError = unreachable();
    await stub.send(prompt('m1'));
    expect(await recoveryAt(stub)).toEqual(expect.any(Number));

    peer.prepareError = null;
    peer.statusErrors = [unreachable()];
    peer.statusViews = [{ state: 'unknown' }];
    peer.prepareView = peer.view('preparing');
    await recover(stub, peer);
    expect(peer.statusCalls).toHaveLength(1);
    expect(await recoveryAt(stub)).toEqual(expect.any(Number));

    await recover(stub, peer);
    expect(peer.statusCalls).toHaveLength(2);
    expect(peer.prepareCalls).toHaveLength(2);
    expect((await rows(stub))[0]).toMatchObject({ state: 'queued', reason: null });
    await expect(stub.getSession()).resolves.toMatchObject({
      route: { state: 'preparing', attemptId: peer.attemptId },
    });
  });

  it('surfaces the known terminal reason when a later pass reaches the sandbox', async () => {
    const { stub, peer } = await setup();
    peer.prepareError = unreachable();
    await stub.send(prompt('m1'));
    peer.statusErrors = [unreachable()];
    await recover(stub, peer);
    expect(await recoveryAt(stub)).toEqual(expect.any(Number));

    peer.attemptId = 'failed-B';
    peer.statusViews = [
      {
        state: 'failed',
        attemptId: peer.attemptId,
        reason: 'workspace_setup_failed',
        subtype: 'git_authentication_failed',
      },
    ];
    await recover(stub, peer);
    expect((await rows(stub))[0]).toMatchObject({
      state: 'failed',
      reason: 'workspace_setup_failed',
    });
    expect(await stub.getMessageResult('m1')).toMatchObject({
      type: 'found',
      result: {
        status: 'failed',
        failure: { code: 'workspace_setup_failed', subtype: 'git_authentication_failed' },
      },
    });
    expect(await recoveryAt(stub)).toBeUndefined();
    expect(peer.prepareCalls).toHaveLength(1);
  });

  it.each(['error', 'held'] as const)(
    'fails queued work as sandbox_unreachable at the end of the window when every pass fails (%s)',
    async mode => {
      const { stub, peer } = await setup();
      const { reports, callbacks } = await captureQueues(stub);
      const pending = held<never>();
      let statusCalls = 0;
      if (mode === 'error') {
        peer.prepareError = unreachable();
        peer.statusError = unreachable();
      } else {
        peer.prepare = async input => {
          peer.prepareCalls.push(input);
          return pending.promise;
        };
        peer.status = async () => {
          statusCalls += 1;
          return pending.promise;
        };
      }
      try {
        await bounded(stub.send(prompt('m1')));
        const first = await storedRecovery(stub);
        expect(first!.dueAt - first!.since).toBe(15_000);

        await expectNextPass(stub, peer, 30_000);
        await expectNextPass(stub, peer, 60_000);
        expect((await rows(stub))[0]).toMatchObject({ state: 'queued', reason: null });
        expect(reports).toHaveLength(0);

        await bounded(recover(stub, peer));
        expect((await rows(stub))[0]).toMatchObject({
          state: 'failed',
          reason: 'sandbox_unreachable',
        });
        expect(await recoveryAt(stub)).toBeUndefined();
        expect(await latestCloudStatus(stub)).toEqual({
          type: 'error',
          message: 'sandbox_unreachable',
        });
        expect(reports).toHaveLength(1);
        expect(callbacks).toHaveLength(1);
        expect(mode === 'error' ? peer.statusCalls.length : statusCalls).toBe(3);
        expect(peer.prepareCalls).toHaveLength(1);

        const after = [peer.statusCalls.length, statusCalls, peer.prepareCalls.length];
        await runInDurableObject(stub, instance => instance.alarm());
        expect([peer.statusCalls.length, statusCalls, peer.prepareCalls.length]).toEqual(after);
        expect([reports.length, callbacks.length]).toEqual([1, 1]);
      } finally {
        pending.resolve(undefined as never);
      }
    },
    20_000
  );

  it('fails queued work whose delivery stays unanswered, with one deliver per pass', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('ready');
    const delivery = held<ControlPlaneDeliverResult>();
    peer.deliver = async payload => {
      peer.deliverCalls.push(payload);
      return delivery.promise;
    };
    try {
      await bounded(stub.send(prompt('m1')));
      await expectNextPass(stub, peer, 30_000);
      await expectNextPass(stub, peer, 60_000);
      await bounded(recover(stub, peer));
      expect((await rows(stub))[0]).toMatchObject({
        state: 'failed',
        reason: 'sandbox_unreachable',
      });
      expect(peer.deliverCalls).toHaveLength(4);
      expect(await recoveryAt(stub)).toBeUndefined();
      // Accepted work may still run on the ready route, so its status stays ready.
      expect(await latestCloudStatus(stub)).toMatchObject({ type: 'ready' });
    } finally {
      delivery.resolve('sent');
    }
  }, 20_000);

  it('ends the window when a pass is answered and opens a new one at the next failure', async () => {
    const { stub, peer } = await setup();
    peer.prepareError = unreachable();
    await stub.send(prompt('m1'));
    peer.statusErrors = [unreachable()];
    const firstPass = await recover(stub, peer);
    expect((await storedRecovery(stub))?.since).toBe(firstPass.since);

    peer.prepareError = null;
    peer.prepareView = peer.view('ready');
    await recover(stub, peer);
    expect((await rows(stub))[0]?.state).toBe('accepted');
    expect(await storedRecovery(stub)).toBeUndefined();

    peer.deliverError = unreachable();
    const before = Date.now();
    await stub.send(prompt('m2'));
    const fresh = await storedRecovery(stub);
    expect(fresh!.since).toBeGreaterThanOrEqual(before);
    expect(fresh!.dueAt - fresh!.since).toBe(15_000);
    expect((await rows(stub))[1]?.state).toBe('queued');
  });

  it('reads a bare due time from an earlier deploy as a window opened one delay before it', async () => {
    const { stub, peer, sessionId } = await setup();
    peer.prepareError = unreachable();
    await stub.send(prompt('m1'));
    const legacyDueAt = Date.now() - 1;
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put(RECOVERY_KEY, legacyDueAt)
    );
    await evictAllDurableObjects();
    const revived = sessions.getByName(sessionId);
    await installPeer(revived, peer);
    peer.statusError = unreachable();
    await runInDurableObject(revived, instance => instance.alarm());
    expect(await storedRecovery(revived)).toEqual({
      dueAt: expect.any(Number),
      since: legacyDueAt - 15_000,
    });
    expect((await rows(revived))[0]?.state).toBe('queued');
  });
});

describe('SandboxSessionV2 queued status check', () => {
  const unreachable = () =>
    Object.assign(new Error('Durable Object storage operation exceeded timeout'), {
      retryable: false,
    });

  async function rollBackAcceptance(
    stub: DurableObjectStub<SandboxSessionV2>,
    sessionId: string,
    peer: FakeSandboxPeer
  ) {
    // A Session DO reset rolls the accepted write back: the message is queued again.
    await runInDurableObject(stub, (_instance, state) =>
      drizzle(state.storage)
        .update(controlPlaneMessages)
        .set({ state: 'queued', accepted_at: null })
        .run()
    );
    await evictAllDurableObjects();
    const revived = sessions.getByName(sessionId);
    await installPeer(revived, peer);
    return revived;
  }

  it('settles queued work with the sandbox reason at the next check after a lost failed notification', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    const before = Date.now();
    await stub.send(prompt('m1'));
    await expectStatusCheck(stub, before);

    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
      subtype: 'git_authentication_failed',
    };
    await recover(stub, peer);
    expect((await rows(stub))[0]).toMatchObject({
      state: 'failed',
      reason: 'workspace_setup_failed',
    });
    expect(await stub.getMessageResult('m1')).toMatchObject({
      type: 'found',
      result: {
        status: 'failed',
        failure: { code: 'workspace_setup_failed', subtype: 'git_authentication_failed' },
      },
    });
    expect(await recoveryAt(stub)).toBeUndefined();
    expect(peer.prepareCalls).toHaveLength(1);
  });

  it('only re-arms when the check reads the same preparing attempt', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(prompt('m1'));
    await stub.onRoute({ state: 'preparing', attemptId: peer.attemptId, step: 'clone' });
    const status = await latestCloudStatus(stub);
    const before = Date.now();
    await recover(stub, peer);
    expect(peer.statusCalls).toHaveLength(1);
    await expectStatusCheck(stub, before);
    expect(await latestCloudStatus(stub)).toEqual(status);
    await expect(stub.getSession()).resolves.toMatchObject({
      route: { state: 'preparing', attemptId: peer.attemptId, step: 'clone' },
    });
    expect((await rows(stub))[0]).toMatchObject({ state: 'queued', reason: null });
  });

  it('delivers a rolled-back acceptance at the next check', async () => {
    const { stub, peer, sessionId } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(prompt('m1'));
    expect((await rows(stub))[0]?.state).toBe('accepted');
    const revived = await rollBackAcceptance(stub, sessionId, peer);
    // Any wake of the object arms the check for its queued work.
    const before = Date.now();
    await runInDurableObject(revived, instance => instance.alarm());
    await expectStatusCheck(revived, before);

    await recover(revived, peer);
    expect((await rows(revived))[0]?.state).toBe('accepted');
    expect(peer.deliverCalls.map(call => call.messages.map(m => m.messageId))).toEqual([
      ['m1'],
      ['m1'],
    ]);
    expect(await recoveryAt(revived)).toBeUndefined();
  });

  it('prepares again after an unknown notification for queued work on a ready route', async () => {
    const { stub, peer, sessionId } = await setup();
    peer.prepareView = peer.view('ready');
    await stub.send(prompt('m1'));
    const revived = await rollBackAcceptance(stub, sessionId, peer);
    const before = Date.now();
    await revived.onRoute({ state: 'unknown' });
    await expectStatusCheck(revived, before);

    peer.prepareView = { state: 'unknown' };
    peer.prepare = async input => {
      peer.prepareCalls.push(input);
      return peer.view('preparing');
    };
    await recover(revived, peer);
    expect(peer.prepareCalls).toHaveLength(2);
    expect((await rows(revived))[0]).toMatchObject({ state: 'queued', reason: null });
    await expect(revived.getSession()).resolves.toMatchObject({
      route: { state: 'preparing', attemptId: peer.attemptId },
    });
  });

  it('opens a recovery window when a check is unanswered and fails a preparing route at its end', async () => {
    const { stub, peer } = await setup();
    peer.prepareView = peer.view('preparing');
    await stub.send(prompt('m1'));
    peer.statusError = unreachable();
    const check = await recover(stub, peer);
    const window = await storedRecovery(stub);
    expect(window!.since).toBeGreaterThanOrEqual(check.dueAt);
    expect(window!.dueAt - window!.since).toBe(15_000);

    await recover(stub, peer);
    await recover(stub, peer);
    expect((await rows(stub))[0]?.state).toBe('queued');
    await recover(stub, peer);
    expect((await rows(stub))[0]).toMatchObject({
      state: 'failed',
      reason: 'sandbox_unreachable',
    });
    expect(peer.statusCalls).toHaveLength(4);
    expect(await recoveryAt(stub)).toBeUndefined();
    expect(await latestCloudStatus(stub)).toEqual({
      type: 'error',
      message: 'sandbox_unreachable',
    });

    const attemptId = peer.attemptId;
    const preparationAttempt = () =>
      runInDurableObject(stub, instance =>
        readPreparationAttempt(
          (instance as unknown as { eventQueries: Parameters<typeof readPreparationAttempt>[0] })
            .eventQueries,
          attemptId
        )
      );
    const closed = await preparationAttempt();
    expect(closed).toMatchObject({ status: 'failed', safeError: 'sandbox_unreachable' });

    // Late notifications for the same attempt apply without queued work to act on.
    peer.statusError = null;
    await stub.onRoute({ state: 'preparing', attemptId, step: 'clone' });
    expect(await preparationAttempt()).toEqual(closed);
    expect(await recoveryAt(stub)).toBeUndefined();
    expect(peer.prepareCalls).toHaveLength(1);
    await stub.onRoute(peer.view('ready'));
    await expect(stub.getSession()).resolves.toMatchObject({
      route: { state: 'ready', attemptId: peer.attemptId },
    });
    expect(peer.deliverCalls).toHaveLength(0);
    expect(await recoveryAt(stub)).toBeUndefined();
  });
});
