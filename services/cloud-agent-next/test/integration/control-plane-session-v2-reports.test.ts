import { FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN } from './helpers/fake-credentials.js';
import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallbackJob } from '../../src/callbacks/types.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { controlPlaneMessages } from '../../src/control-plane/session/sqlite-schema.js';
import { logger } from '../../src/logger.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import type { ControlPlanePromptPayload } from '../../src/shared/control-plane-protocol.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';
import { waitFor } from './wait-for.js';

type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const NATIVE_KILO_TOKEN = FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN;
const QUEUED_BACKSTOP_MS = CONTROL_PLANE_TIMERS.session.queuedBackstopMs;

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}`;
}
function newSessionId(): string {
  return `workspace_${crypto.randomUUID()}`;
}
function kiloSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}

function metadata(input: { sessionId: string; kiloSessionId: string; sandboxId: string }) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId,
      userId: 'user_123',
      orgId: 'org_123',
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: input.kiloSessionId, kilocodeToken: NATIVE_KILO_TOKEN },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
    workspace: {
      branchName: 'kilo/test-branch',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare',
    },
    callback: { target: { url: 'https://callback.test/hook' } },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function promptPayload(messageId: string, prompt = 'hello'): ControlPlanePromptPayload {
  return {
    messageId,
    turn: { type: 'prompt', prompt },
    agent: { mode: 'code', model: 'test/model' },
  };
}

type Captured = {
  reports: CloudAgentQueueReport[];
  callbacks: CallbackJob[];
};

/** Overrides the two outbound queues with in-memory captures the DO reads lazily. */
async function installCapturedQueues(stub: DurableObjectStub<SandboxSessionV2>): Promise<Captured> {
  const captured: Captured = { reports: [], callbacks: [] };
  await runInDurableObject(stub, instance => {
    instance.env.CLOUD_AGENT_REPORT_QUEUE = {
      send: async (report: CloudAgentQueueReport) => {
        captured.reports.push(report);
      },
    } as never;
    instance.env.CALLBACK_QUEUE = {
      send: async (job: CallbackJob) => {
        captured.callbacks.push(job);
      },
    } as never;
  });
  return captured;
}

async function installPeer(
  stub: DurableObjectStub<SandboxSessionV2>,
  peer: FakeSandboxPeer
): Promise<void> {
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => peer;
  });
}

async function messageStatus(
  stub: DurableObjectStub<SandboxSessionV2>,
  messageId: string
): Promise<string | null> {
  const result = await stub.getMessageResult(messageId);
  return result.type === 'found' ? result.result.status : null;
}

/** Drives the alarm, which repairs both outboxes; makes queue capture deterministic. */
async function flush(stub: DurableObjectStub<SandboxSessionV2>): Promise<void> {
  await runInDurableObject(stub, instance => instance.alarm());
}

/** Injects custom queue behaviour (for failure/retry tests) the DO reads lazily. */
async function installQueues(
  stub: DurableObjectStub<SandboxSessionV2>,
  sendReport: (report: CloudAgentQueueReport) => Promise<void>,
  sendCallback: (job: CallbackJob) => Promise<void>
): Promise<void> {
  await runInDurableObject(stub, instance => {
    instance.env.CLOUD_AGENT_REPORT_QUEUE = { send: sendReport } as never;
    instance.env.CALLBACK_QUEUE = { send: sendCallback } as never;
  });
}

async function readAlarm(stub: DurableObjectStub<SandboxSessionV2>): Promise<number | null> {
  return await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function setup(callbackUrl = 'https://callback.test/hook'): Promise<{
  sessionId: string;
  stub: DurableObjectStub<SandboxSessionV2>;
  peer: FakeSandboxPeer;
}> {
  const sessionId = newSessionId();
  const sandboxId = unique('sbx__reports');
  const stub = sessions.getByName(sessionId);
  const sessionMetadata = metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId });
  sessionMetadata.callback = { target: { url: callbackUrl } };
  await stub.registerSessionFromMetadata({
    metadata: sessionMetadata,
    sandboxSelection: { provider: 'cloudflare' },
  });
  const peer = new FakeSandboxPeer();
  peer.prepareView = peer.view('ready');
  await installPeer(stub, peer);
  return { sessionId, stub, peer };
}

afterEach(async () => {
  await reset();
});

describe('SandboxSessionV2 reports and callbacks', () => {
  it.each(['terminal_only', 'persisted', 'replacement', 'initial'] as const)(
    'captures attempted preparation runtime before dispatch: %s',
    async source => {
      const { stub, peer } = await setup();
      const captured = await installCapturedQueues(stub);
      const container = {
        provider: 'cloudflare' as const,
        sandboxId: 'sandbox-1',
        allocationId: 'allocation-1',
        instanceId: 'allocation-1',
        startSource: 'image' as const,
      };
      peer.prepareView =
        source === 'initial'
          ? {
              state: 'failed',
              attemptId: peer.attemptId,
              reason: 'workspace_setup_failed',
              container,
            }
          : {
              state: 'preparing',
              attemptId: peer.attemptId,
              ...(source === 'terminal_only' ? {} : { container }),
            };
      await stub.send(promptPayload('m1'));
      if (source !== 'initial') {
        expect(await messageStatus(stub, 'm1')).toBe('queued');
        const failed = {
          state: 'failed' as const,
          attemptId: peer.attemptId,
          reason: 'workspace_setup_failed' as const,
          ...(source === 'persisted'
            ? {}
            : {
                container:
                  source === 'replacement'
                    ? { ...container, allocationId: 'unrelated', instanceId: 'unrelated' }
                    : container,
              }),
        };
        peer.prepareView = failed;
        await stub.onRoute(failed);
      }
      expect(peer.deliverCalls).toHaveLength(0);
      peer.statusError = new Error('report consumption must not look up runtime');
      await flush(stub);
      expect(captured.reports).toHaveLength(1);
      expect(captured.reports[0]?.run).toMatchObject({
        status: 'failed',
        failureStage: 'pre_dispatch',
        container,
      });
      expect(captured.reports[0]?.run.dispatchAcceptedAt).toBeUndefined();
    }
  );

  it('captures a lost preparing route without attributing queued work to the replacement', async () => {
    const { stub, peer } = await setup();
    const captured = await installCapturedQueues(stub);
    const container = {
      provider: 'cloudflare' as const,
      sandboxId: 'sandbox-1',
      allocationId: 'allocation-1',
      instanceId: 'allocation-1',
    };
    const attemptId = peer.attemptId;
    peer.prepareView = { state: 'preparing', attemptId, container };
    await stub.send(promptPayload('m1'));
    peer.attemptId = crypto.randomUUID();
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
      container: { ...container, allocationId: 'unrelated', instanceId: 'unrelated' },
    };
    await stub.onRoute({ state: 'lost', attemptId, reason: 'sandbox_lost', container });
    await flush(stub);
    expect(peer.deliverCalls).toHaveLength(0);
    expect(captured.reports).toHaveLength(1);
    expect(captured.reports[0]?.run).toMatchObject({ status: 'failed', container });
  });

  it('captures a new immediate preparation failure after a previously failed attempt', async () => {
    const { stub, peer } = await setup();
    const captured = await installCapturedQueues(stub);
    const container = {
      provider: 'cloudflare' as const,
      sandboxId: 'sandbox-1',
      allocationId: 'allocation-1',
    };
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
      container,
    };
    await stub.send(promptPayload('m1'));
    const replacement = { ...container, allocationId: 'allocation-2' };
    peer.attemptId = crypto.randomUUID();
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
      container: replacement,
    };
    await stub.send(promptPayload('m2'));
    await flush(stub);
    expect(captured.reports.find(report => report.run.messageId === 'm1')?.run.container).toEqual(
      container
    );
    expect(captured.reports.find(report => report.run.messageId === 'm2')?.run.container).toEqual(
      replacement
    );
  });

  it('preserves accepted runtime while a queued message fails on its preparation runtime', async () => {
    const { stub, peer } = await setup();
    const captured = await installCapturedQueues(stub);
    const original = {
      provider: 'cloudflare' as const,
      sandboxId: 'sandbox-1',
      allocationId: 'allocation-1',
      instanceId: 'allocation-1',
    };
    peer.prepareView = { state: 'ready', attemptId: peer.attemptId, container: original };
    await stub.send(promptPayload('accepted'));
    const preparing = { ...original, allocationId: 'allocation-2', instanceId: 'allocation-2' };
    peer.prepareView = { state: 'preparing', attemptId: peer.attemptId, container: preparing };
    await stub.onRoute(peer.prepareView);
    await stub.send(promptPayload('queued'));
    peer.prepareView = {
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
      container: preparing,
    };
    await stub.onRoute(peer.prepareView);
    await flush(stub);
    expect(
      captured.reports.find(report => report.run.messageId === 'accepted')?.run.container
    ).toEqual(original);
    expect(
      captured.reports.find(report => report.run.messageId === 'queued')?.run.container
    ).toEqual(preparing);
  });

  it('persists runtime before dispatch and retains it through route replacement and eviction', async () => {
    const { sessionId, stub, peer } = await setup();
    let captured = await installCapturedQueues(stub);
    const original = {
      provider: 'vercel' as const,
      sandboxId: 'sandbox-1',
      allocationId: 'allocation-1',
      instanceId: 'physical-session-1',
      snapshotId: 'snapshot-1',
      runtimeBuildId: 'build-1',
      startSource: 'snapshot' as const,
    };
    peer.prepareView = { state: 'ready', attemptId: peer.attemptId, container: original };
    const deliver = peer.deliver.bind(peer);
    await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      peer.deliver = async payload => {
        const stored = await db.select().from(controlPlaneMessages);
        expect(stored.map(row => JSON.parse(row.container ?? 'null'))).toEqual([original]);
        expect(payload.allocationId).toBe(original.allocationId);
        return deliver(payload);
      };
    });
    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));

    const replacement = {
      ...original,
      allocationId: 'allocation-2',
      instanceId: 'physical-session-2',
    };
    await stub.onRoute({ state: 'ready', attemptId: peer.attemptId, container: replacement });
    await evictAllDurableObjects();
    captured = await installCapturedQueues(stub);
    peer.deliver = deliver;
    peer.prepareView = { state: 'ready', attemptId: peer.attemptId, container: replacement };
    await installPeer(stub, peer);
    await stub.send(promptPayload('m2'));
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));
    peer.statusError = new Error('reports must not query current runtime');
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm2' });
    await flush(stub);
    expect(captured.reports.find(report => report.run.messageId === 'm1')?.run.container).toEqual(
      original
    );
    expect(captured.reports.find(report => report.run.messageId === 'm2')?.run.container).toEqual(
      replacement
    );
  });

  it('replaces queued metadata on a not_ready retry and freezes it after acceptance', async () => {
    const { sessionId, stub, peer } = await setup();
    const captured = await installCapturedQueues(stub);
    const original = {
      provider: 'cloudflare' as const,
      sandboxId: 'sandbox-1',
      allocationId: 'allocation-1',
      instanceId: 'allocation-1',
      startSource: 'image' as const,
    };
    const replacement = { ...original, allocationId: 'allocation-2', instanceId: 'allocation-2' };
    peer.prepareViews = [
      { state: 'ready', attemptId: peer.attemptId, container: original },
      { state: 'ready', attemptId: peer.attemptId, container: replacement },
    ];
    peer.prepareView = { state: 'ready', attemptId: peer.attemptId, container: replacement };
    peer.deliverResults = ['not_ready', 'sent'];
    const deliver = peer.deliver.bind(peer);
    peer.deliver = async payload => {
      const result = await deliver(payload);
      if (result === 'not_ready') peer.attemptId = crypto.randomUUID();
      return result;
    };
    await stub.send(promptPayload('m1'));
    expect(await messageStatus(stub, 'm1')).toBe('queued');
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const [row] = await db.select().from(controlPlaneMessages);
      expect(JSON.parse(row?.container ?? 'null')).toEqual(original);
    });

    await runInDurableObject(stub, async (instance, state) => {
      const dueAt = Date.now() - 1;
      await state.storage.put('control_plane_transport_recovery_at', dueAt);
      Object.assign(instance, { transportRecoveryAt: dueAt });
      await instance.alarm();
    });
    expect(await messageStatus(stub, 'm1')).toBe('running');
    expect(peer.deliverCalls.map(call => call.allocationId)).toEqual([
      original.allocationId,
      replacement.allocationId,
    ]);
    await stub.onRoute({ state: 'ready', attemptId: peer.attemptId, container: original });
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    await flush(stub);
    expect(captured.reports).toHaveLength(1);
    expect(captured.reports[0]?.run.container).toEqual(replacement);
  });

  it('retains a captured queued container when a retry route has no runtime metadata', async () => {
    const { sessionId, stub, peer } = await setup();
    const captured = await installCapturedQueues(stub);
    const original = {
      provider: 'cloudflare' as const,
      sandboxId: 'sandbox-1',
      allocationId: 'allocation-1',
      instanceId: 'allocation-1',
      startSource: 'image' as const,
    };
    peer.prepareViews = [
      { state: 'ready', attemptId: peer.attemptId, container: original },
      { state: 'ready', attemptId: peer.attemptId },
    ];
    peer.prepareView = { state: 'ready', attemptId: peer.attemptId };
    peer.deliverResults = ['not_ready', 'sent'];
    const deliver = peer.deliver.bind(peer);
    peer.deliver = async payload => {
      const result = await deliver(payload);
      if (result === 'not_ready') peer.attemptId = crypto.randomUUID();
      return result;
    };
    await stub.send(promptPayload('m1'));
    expect(await messageStatus(stub, 'm1')).toBe('queued');
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const [row] = await db.select().from(controlPlaneMessages);
      expect(JSON.parse(row?.container ?? 'null')).toEqual(original);
    });

    await runInDurableObject(stub, async (instance, state) => {
      const dueAt = Date.now() - 1;
      await state.storage.put('control_plane_transport_recovery_at', dueAt);
      Object.assign(instance, { transportRecoveryAt: dueAt });
      await instance.alarm();
    });
    expect(await messageStatus(stub, 'm1')).toBe('running');
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    await flush(stub);
    expect(captured.reports).toHaveLength(1);
    expect(captured.reports[0]?.run.container).toEqual(original);
  });

  it('uses the original runtime when reallocation terminalizes accepted work', async () => {
    const { stub, peer } = await setup();
    const captured = await installCapturedQueues(stub);
    const original = {
      provider: 'cloudflare' as const,
      sandboxId: 'sandbox-1',
      allocationId: 'allocation-1',
      instanceId: 'allocation-1',
      startSource: 'image' as const,
    };
    peer.prepareView = { state: 'ready', attemptId: peer.attemptId, container: original };
    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    peer.attemptId = crypto.randomUUID();
    peer.prepareView = {
      state: 'preparing',
      attemptId: peer.attemptId,
      container: { ...original, allocationId: 'allocation-2', instanceId: 'allocation-2' },
    };
    peer.deliverResult = 'not_ready';
    await stub.send(promptPayload('m2'));
    await flush(stub);
    expect(captured.reports).toHaveLength(1);
    expect(captured.reports[0]?.run).toMatchObject({ status: 'failed', container: original });
  });

  it('settles an evicted legacy message with null runtime metadata without a live lookup', async () => {
    const { sessionId, stub, peer } = await setup();
    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const [row] = await db.select().from(controlPlaneMessages);
      expect(row?.container).toBeNull();
    });
    await evictAllDurableObjects();
    const captured = await installCapturedQueues(stub);
    peer.statusError = new Error('legacy report must not query runtime');
    await installPeer(stub, peer);
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    await flush(stub);
    expect(captured.reports).toHaveLength(1);
    expect(captured.reports[0]?.run).not.toHaveProperty('container');
  });

  it('ignores a malformed stored container instead of failing initialization', async () => {
    const { stub } = await setup();
    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db
        .update(controlPlaneMessages)
        .set({ container: '{ not json' })
        .where(eq(controlPlaneMessages.message_id, 'm1'));
    });
    await evictAllDurableObjects();
    expect(await messageStatus(stub, 'm1')).toBe('running');
  });

  it('persists parent delivery identity and deduplicates its admitted parent turn', async () => {
    const { sessionId, stub } = await setup('session:parent');
    const captured = await installCapturedQueues(stub);
    await stub.send(promptPayload('child-task'));
    await waitFor(async () => expect(await messageStatus(stub, 'child-task')).toBe('running'));
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'child-task' });
    await flush(stub);
    expect(captured.callbacks).toHaveLength(1);
    const callback = captured.callbacks[0];
    expect(callback.parentSession).toMatchObject({
      userId: 'user_123',
      messageId: expect.stringMatching(/^msg_/),
    });
    if (!callback.parentSession) throw new Error('Missing parent delivery identity');
    const { stub: parent } = await setup();
    await installCapturedQueues(parent);
    const intent = promptPayload(callback.parentSession.messageId, 'Child task completed');
    await parent.send(intent);
    await parent.send(intent);
    const rows = await runInDurableObject(parent, (_instance, state) =>
      drizzle(state.storage).select().from(controlPlaneMessages).all()
    );
    expect(rows.filter(row => row.message_id === callback.parentSession?.messageId)).toHaveLength(
      1
    );
  });
  it('writes one report per terminal message and one batch callback under the session id', async () => {
    const { sessionId, stub } = await setup();
    const captured = await installCapturedQueues(stub);

    await stub.send(promptPayload('m1'));
    await stub.send(promptPayload('m2'));
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));

    await stub.onOutcome({
      sessionId,
      status: 'completed',
      lastMessageId: 'm2',
      gateResult: 'fail',
    });
    await flush(stub);

    expect(captured.reports.map(report => report.run.messageId).sort()).toEqual(['m1', 'm2']);
    expect(captured.reports.every(report => report.session.cloudAgentSessionId === sessionId)).toBe(
      true
    );
    expect(captured.reports.map(report => report.run.status)).toEqual(['completed', 'completed']);
    expect(captured.reports[0]?.session).toMatchObject({
      cloudAgentSessionId: sessionId,
      kiloSessionId: expect.any(String),
      initialMessageId: 'm1',
      reportingCreatedAt: expect.any(String),
    });

    expect(captured.callbacks).toHaveLength(1);
    expect(captured.callbacks[0]?.payload).toMatchObject({
      sessionId,
      cloudAgentSessionId: sessionId,
      status: 'completed',
      messageId: 'm2',
      gateResult: 'fail',
    });
  });

  it('writes a failed report with its stage/code and one callback for a failure batch', async () => {
    const { stub, peer } = await setup();
    const captured = await installCapturedQueues(stub);

    await stub.send(promptPayload('m1'));
    await stub.send(promptPayload('m2'));
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));

    await stub.onRoute({
      state: 'failed',
      attemptId: peer.attemptId,
      reason: 'workspace_setup_failed',
      subtype: 'git_rate_limited',
    });
    await flush(stub);

    expect(captured.reports).toHaveLength(2);
    for (const report of captured.reports) {
      expect(report.run.status).toBe('failed');
      expect(report.run.failureStage).toBe('pre_dispatch');
      expect(report.run.failureCode).toBe('workspace_setup_failed');
      expect(report.run.workspaceFailureSubtype).toBe('git_rate_limited');
      expect(report.run.diagnostic).toBeDefined();
    }
    expect(captured.callbacks).toHaveLength(1);
    expect(captured.callbacks[0]?.payload.status).toBe('failed');
    expect(captured.callbacks[0]?.payload.clientError).toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      retryable: true,
    });
  });

  it('writes interrupted reports and one callback for a Stop batch', async () => {
    const { stub } = await setup();
    const captured = await installCapturedQueues(stub);

    await stub.send(promptPayload('m1'));
    await stub.send(promptPayload('m2'));
    await waitFor(async () => expect(await messageStatus(stub, 'm2')).toBe('running'));

    await stub.stop();
    await flush(stub);

    expect(captured.reports).toHaveLength(2);
    for (const report of captured.reports) {
      expect(report.run.status).toBe('interrupted');
      expect(report.run.failureStage).toBe('interruption');
      expect(report.run.failureCode).toBe('user_interrupt');
    }
    expect(captured.callbacks).toHaveLength(1);
    expect(captured.callbacks[0]?.payload.status).toBe('interrupted');
    expect(captured.callbacks[0]?.payload.clientError).toMatchObject({
      code: 'USER_INTERRUPT',
      retryable: false,
    });
  });

  it('writes a backstop report for a new-plane reason', async () => {
    const { stub, peer } = await setup();
    const captured = await installCapturedQueues(stub);

    // Keep the message queued so the queued backstop (`preparation_timeout`) fires.
    const container = {
      provider: 'cloudflare' as const,
      sandboxId: 'sandbox-1',
      allocationId: 'allocation-1',
    };
    peer.prepareView = { state: 'preparing', attemptId: peer.attemptId, container };
    await stub.send(promptPayload('m1'));
    expect(await messageStatus(stub, 'm1')).toBe('queued');
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db
        .update(controlPlaneMessages)
        .set({ created_at: Date.now() - QUEUED_BACKSTOP_MS - 1 })
        .where(eq(controlPlaneMessages.message_id, 'm1'));
    });

    await flush(stub);
    expect(await messageStatus(stub, 'm1')).toBe('failed');
    const report = captured.reports.find(candidate => candidate.run.messageId === 'm1');
    expect(report?.run.status).toBe('failed');
    expect(report?.run.failureStage).toBe('pre_dispatch');
    expect(report?.run.failureCode).toBe('wrapper_start_failed');
    expect(report?.run.container).toEqual(container);
    expect(captured.callbacks).toHaveLength(1);
    expect(captured.callbacks[0]?.payload.status).toBe('failed');
  });

  it('does not double-write on a repeat outcome', async () => {
    const { sessionId, stub } = await setup();
    const captured = await installCapturedQueues(stub);

    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));

    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    await flush(stub);
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    await flush(stub);

    expect(captured.reports).toHaveLength(1);
    expect(captured.callbacks).toHaveLength(1);
  });

  it('does not fail the turn when a report cannot be recorded', async () => {
    const { sessionId, stub } = await setup();
    await runInDurableObject(stub, instance => {
      const holder = instance as unknown as {
        reportOutbox: { record(report: CloudAgentQueueReport): void; repair(): Promise<void> };
      };
      holder.reportOutbox = {
        ...holder.reportOutbox,
        record() {
          throw new Error('report record exploded');
        },
      };
      instance.env.CLOUD_AGENT_REPORT_QUEUE = { send: async () => {} } as never;
    });

    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await expect(
      stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' })
    ).resolves.toBeUndefined();
    expect(await messageStatus(stub, 'm1')).toBe('completed');
  });

  it('keeps the retry alarm armed when the report queue rejects a send, and retries', async () => {
    const { sessionId, stub } = await setup();
    const reports: CloudAgentQueueReport[] = [];
    let attempts = 0;
    await installQueues(
      stub,
      async report => {
        attempts += 1;
        if (attempts === 1) throw new Error('report queue down');
        reports.push(report);
      },
      async () => {}
    );

    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await expect(
      stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' })
    ).resolves.toBeUndefined();
    await flush(stub);

    expect(await messageStatus(stub, 'm1')).toBe('completed');
    // Nothing is open, yet the failed report keeps a retry alarm armed.
    expect(await readAlarm(stub)).not.toBeNull();

    // Make the retry due and let the armed alarm deliver it.
    await runInDurableObject(stub, async (_instance, state) => {
      for (const [key, value] of state.storage.kv.list({ prefix: 'report_outbox:' })) {
        const entry = value as { report: CloudAgentQueueReport; attempts: number; dueAt: number };
        state.storage.kv.put(key, { ...entry, dueAt: Date.now() - 1 });
      }
    });
    await flush(stub);

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(reports).toHaveLength(1);
  });

  it('keeps the retry alarm armed when the callback queue rejects a send, and retries', async () => {
    const { sessionId, stub } = await setup();
    const callbacks: CallbackJob[] = [];
    let attempts = 0;
    await installQueues(
      stub,
      async () => {},
      async job => {
        attempts += 1;
        if (attempts === 1) throw new Error('callback queue down');
        callbacks.push(job);
      }
    );

    await stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stub, 'm1')).toBe('running'));
    await stub.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
    await flush(stub);

    // The callback obligation is the only thing keeping the session non-idle.
    expect(await readAlarm(stub)).not.toBeNull();

    await runInDurableObject(stub, async (_instance, state) => {
      for (const [key, value] of state.storage.kv.list({ prefix: 'callback_outbox:' })) {
        const entry = value as { job: CallbackJob; attempts: number; dueAt: number };
        state.storage.kv.put(key, { ...entry, dueAt: Date.now() - 1 });
      }
    });
    await flush(stub);

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(callbacks).toHaveLength(1);
  });

  it('emits the session_message_committed diagnostic for accepted and terminal transitions', async () => {
    const { sessionId, stub } = await setup();
    await installCapturedQueues(stub);
    // Spy inside the DO context (the proven pattern) so both the accepted and
    // terminal transitions are observed.
    const committed = await runInDurableObject(stub, async instance => {
      const withFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      try {
        await instance.send(promptPayload('m1'));
        await waitFor(async () => {
          const result = await instance.getMessageResult('m1');
          expect(result.type === 'found' ? result.result.status : null).toBe('running');
        });
        await instance.onOutcome({ sessionId, status: 'completed', lastMessageId: 'm1' });
        await instance.alarm();
        return withFields.mock.calls
          .map(call => call[0] as Record<string, unknown>)
          .filter(fields => fields.diagnosticEvent === 'session_message_committed');
      } finally {
        withFields.mockRestore();
        info.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
    });

    expect(committed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          source: 'coordinator',
          messageId: 'm1',
          fromState: 'queued',
          toState: 'accepted',
          lifecycleEventInserted: false,
        }),
        expect.objectContaining({
          sessionId,
          source: 'wrapper_outcome',
          messageId: 'm1',
          fromState: 'accepted',
          toState: 'completed',
          lifecycleEventInserted: true,
          terminalAt: expect.any(Number),
        }),
      ])
    );
  });

  it('reports sandbox_stopped and execution_limit as interrupted instead of dropping them', async () => {
    const stopped = await setup();
    const capturedStopped = await installCapturedQueues(stopped.stub);
    await stopped.stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(stopped.stub, 'm1')).toBe('running'));
    await stopped.stub.onRoute({
      state: 'lost',
      attemptId: stopped.peer.attemptId,
      reason: 'sandbox_stopped',
    });
    await flush(stopped.stub);

    expect(await messageStatus(stopped.stub, 'm1')).toBe('failed');
    expect(capturedStopped.reports).toHaveLength(1);
    expect(capturedStopped.reports[0]?.run.status).toBe('interrupted');
    expect(capturedStopped.reports[0]?.run.failureStage).toBe('interruption');
    expect(capturedStopped.reports[0]?.run.failureCode).toBe('system_interrupt');

    const limited = await setup();
    const capturedLimited = await installCapturedQueues(limited.stub);
    await limited.stub.send(promptPayload('m1'));
    await waitFor(async () => expect(await messageStatus(limited.stub, 'm1')).toBe('running'));
    await limited.stub.onOutcome({
      sessionId: limited.sessionId,
      status: 'failed',
      reason: 'execution_limit',
      lastMessageId: 'm1',
    });
    await flush(limited.stub);

    expect(await messageStatus(limited.stub, 'm1')).toBe('failed');
    expect(capturedLimited.reports).toHaveLength(1);
    expect(capturedLimited.reports[0]?.run.status).toBe('interrupted');
    expect(capturedLimited.reports[0]?.run.failureStage).toBe('interruption');
    expect(capturedLimited.reports[0]?.run.failureCode).toBe('system_interrupt');
  });
});
