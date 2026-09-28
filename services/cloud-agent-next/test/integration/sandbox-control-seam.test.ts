import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createMemoryProviderAdapter } from '../../src/sandbox-control/provider.js';
import { encodeCloudflareProviderRef } from '../../src/sandbox-control/cloudflare-provider.js';
import { attachRoute, emptyRouteTable } from '../../src/sandbox-control/session-routes.js';
import { saveRouteTable } from '../../src/sandbox-control/durable-state.js';
import { callbackOutboxKey } from '../../src/sandbox-session/message-callbacks.js';
import { getSandboxSessionStub } from '../../src/sandbox-session/session-stub.js';
import type { StopProof } from '../../src/sandbox-state/model/allocation.js';
import {
  readCanonicalAllocationRecord,
  readSessionValueSync,
  writeSessionMessages,
  writeSessionValueSync,
} from '../../src/sandbox-state/persist/access.js';
import { readRawSessionMessages } from '../../src/sandbox-state/persist/load.js';
import {
  acceptedState,
  queuedState,
} from '../../src/sandbox-session/session-state.test-helpers.js';
import { seedCanonicalRunning } from './canonical-allocation-fixtures.js';

const ownerId = 'user_control_seam';
const kiloToken = 'control-seam-kilo-token';
const ATTACHED_SESSION_KEY = 'terminal_attached_session';

type SeamIds = {
  sessionId: string;
  kiloSessionId: string;
  sandboxId: string;
  wrapperInstanceId: string;
  directory: string;
};

function makeIds(): SeamIds {
  const identity = crypto.randomUUID();
  return {
    sessionId: `workspace_${identity}`,
    kiloSessionId: `ses_${identity.replaceAll('-', '').slice(0, 26)}`,
    sandboxId: `ses-${identity.replaceAll('-', '')}`,
    wrapperInstanceId: crypto.randomUUID(),
    directory: `/workspace/seam/${identity}`,
  };
}

async function registerSeamSession(
  ids: SeamIds,
  options: { sandboxProvider?: string; callbackUrl?: string } = {}
) {
  const stub = getSandboxSessionStub(env, ownerId, ids.sessionId);
  await runInDurableObject(stub, async instance => {
    const result = await instance.registerSession({
      identity: { sessionId: ids.sessionId, userId: ownerId, createdOnPlatform: 'cloud-agent-web' },
      auth: { kiloSessionId: ids.kiloSessionId, kilocodeToken: kiloToken },
      agent: { mode: 'code', model: 'test-model' },
      workspace: {
        sandboxId: ids.sandboxId,
        sandboxProvider: options.sandboxProvider ?? 'cloudflare',
      },
      ...(options.callbackUrl ? { callback: { target: { url: options.callbackUrl } } } : {}),
    });
    expect(result.success).toBe(true);
  });
  return stub;
}

function acceptedRow(ids: SeamIds, messageId: string) {
  return {
    messageId,
    state: acceptedState({
      legacy: { prompt: 'held turn' },
      wrapperInstanceId: ids.wrapperInstanceId,
      acceptedAt: Date.now(),
      lastActivityAt: Date.now(),
      executionDeadlineAt: Date.now() + 60_000,
    }),
  };
}

function stopProof(ids: SeamIds, incarnation: string): StopProof {
  return {
    effect: 'destroy',
    at: Date.now(),
    providerRef: encodeCloudflareProviderRef({
      sandboxId: ids.sandboxId,
      containment: true,
      instanceId: incarnation,
    }),
    incarnation,
    reason: 'idle',
    wrapper: ids.wrapperInstanceId,
  };
}

type AttachmentOverrides = {
  wrapperInstanceId?: string;
  allocationIncarnation?: string;
};

async function seedLegacyAttachment(
  session: Awaited<ReturnType<typeof registerSeamSession>>,
  ids: SeamIds,
  messageId: string,
  overrides: AttachmentOverrides = {}
): Promise<void> {
  await runInDurableObject(session, async (_instance, state) => {
    writeSessionMessages(state.storage, { kind: 'unresolved' }, [acceptedRow(ids, messageId)]);
    await state.storage.put(ATTACHED_SESSION_KEY, {
      ownerId,
      sessionId: ids.sessionId,
      kiloSessionId: ids.kiloSessionId,
      directory: ids.directory,
      sandboxId: ids.sandboxId,
      wrapperInstanceId: overrides.wrapperInstanceId ?? ids.wrapperInstanceId,
      ...(overrides.allocationIncarnation !== undefined
        ? { allocationIncarnation: overrides.allocationIncarnation }
        : {}),
    });
  });
}

type LegacyPromptAuthorization = {
  operation: 'session.prompt';
  operationId: string;
  messageId: string;
  session: { sessionId: string; kiloSessionId: string; directory: string };
  wrapperInstanceId: string;
  dispatchDeadlineAt: number;
};

function legacyPromptAuthorization(ids: SeamIds, messageId: string): LegacyPromptAuthorization {
  return {
    operation: 'session.prompt',
    operationId: messageId,
    messageId,
    session: {
      sessionId: ids.sessionId,
      kiloSessionId: ids.kiloSessionId,
      directory: ids.directory,
    },
    wrapperInstanceId: ids.wrapperInstanceId,
    dispatchDeadlineAt: Date.now() + 60_000,
  };
}

/**
 * Seed a raw legacy bare-array session value with a queued prompt whose prompt
 * proof was already dispatched, plus the incarnation-less pre-C3b attachment.
 * The upgrade path must decode this through the frozen legacy decoder.
 */
async function seedLegacyDispatchedPrompt(
  session: Awaited<ReturnType<typeof registerSeamSession>>,
  ids: SeamIds,
  messageId: string,
  options: {
    authorization: LegacyPromptAuthorization;
    executionDeadlineAt: number;
    preparationAttemptId?: string;
  }
): Promise<void> {
  await runInDurableObject(session, async (_instance, state) => {
    writeSessionValueSync(state.storage.kv, [
      {
        messageId,
        state: 'queued',
        version: 2,
        intent: {
          turn: { type: 'prompt', messageId, prompt: 'legacy dispatched prompt' },
          agent: { mode: 'code', model: 'test-model' },
        },
        queuedAt: Date.now() - 1_000,
        deliveryDeadlineAt: Date.now() + 60_000,
        preparationAttemptId: options.preparationAttemptId ?? 'legacy-attempt',
        wrapperInstanceId: ids.wrapperInstanceId,
        operations: {
          prompt: {
            authorization: options.authorization,
            dispatched: true,
            executionDeadlineAt: options.executionDeadlineAt,
          },
        },
      },
    ]);
    await state.storage.put(ATTACHED_SESSION_KEY, {
      ownerId,
      sessionId: ids.sessionId,
      kiloSessionId: ids.kiloSessionId,
      directory: ids.directory,
      sandboxId: ids.sandboxId,
      wrapperInstanceId: ids.wrapperInstanceId,
    });
  });
}

type ReconcileControlOptions = {
  status: Record<string, unknown>;
  operationState: 'running' | 'missing';
  authorization: LegacyPromptAuthorization;
  executionDeadlineAt: number;
};

/** A session-facing control stub for the reconciliation alarm path. */
function reconcileSessionControl(ids: SeamIds, options: ReconcileControlOptions) {
  const operations: string[] = [];
  const control = {
    getStatus: async () => options.status,
    getRuntimeCredentialProxyFence: async () => null,
    ensureReady: async () => ({
      physical: 'running' as const,
      connection: 'ready' as const,
      ...options.status,
    }),
    attachSession: async () => ({}),
    request: async (request: { operation: string }) => {
      operations.push(request.operation);
      if (request.operation !== 'session.operation.get')
        throw new Error(`Unexpected control request: ${request.operation}`);
      return {
        type: 'response' as const,
        requestId: 'lookup',
        ok: true as const,
        result:
          options.operationState === 'running'
            ? {
                state: 'running',
                authorization: options.authorization,
                executionDeadlineAt: options.executionDeadlineAt,
              }
            : { state: 'missing' },
      };
    },
  };
  return { control, operations };
}

type SessionStopSeam = {
  notifyStopped(input: { stopProof: StopProof | undefined; reason: string }): Promise<{
    outcome: 'delivered' | 'failed';
    reason?: string;
  }>;
};

/** Count terminal callback/report repairs scheduled by the session seam. */
async function countRepairs(
  session: Awaited<ReturnType<typeof registerSeamSession>>,
  notify: (instance: SessionStopSeam) => Promise<void>
): Promise<{ callbacks: number; reports: number }> {
  return runInDurableObject(session, async instance => {
    const prototype = Object.getPrototypeOf(instance) as {
      scheduleCallbackRepair: () => void;
      scheduleReportRepair: () => void;
    };
    const callbacks = vi.spyOn(prototype, 'scheduleCallbackRepair');
    const reports = vi.spyOn(prototype, 'scheduleReportRepair');
    await notify(instance as unknown as SessionStopSeam);
    return { callbacks: callbacks.mock.calls.length, reports: reports.mock.calls.length };
  });
}

describe('sandbox control seam (live wiring)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('terminalizes a bound session exactly once and clears the binding', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_exactly_once';
    const session = await registerSeamSession(ids);
    const incarnation = 'incarnation-seam-1';
    await runInDurableObject(session, async (_instance, state) => {
      writeSessionMessages(state.storage, { kind: 'unresolved' }, [acceptedRow(ids, messageId)]);
      await state.storage.put(ATTACHED_SESSION_KEY, {
        ownerId,
        sessionId: ids.sessionId,
        kiloSessionId: ids.kiloSessionId,
        directory: ids.directory,
        sandboxId: ids.sandboxId,
        wrapperInstanceId: ids.wrapperInstanceId,
        allocationIncarnation: incarnation,
      });
    });

    await runInDurableObject(session, async instance => {
      const proof = stopProof(ids, incarnation);
      await expect(instance.notifyStopped({ reason: 'idle', stopProof: proof })).resolves.toEqual({
        outcome: 'delivered',
      });
      // A replayed confirmation must not terminalize twice.
      await instance.notifyStopped({ reason: 'idle', stopProof: proof });
    });

    await runInDurableObject(session, async (_instance, state) => {
      const messages = readRawSessionMessages(state.storage.kv);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ state: { kind: 'failed', reason: 'idle' } });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
    });
  });

  it.each([
    { kind: 'accepted' as const, expected: { kind: 'failed', reason: 'idle' } },
    { kind: 'queued' as const, expected: { kind: 'queued' } },
  ])(
    'persists an unbound envelope and deletes the attachment for stopped $kind work',
    async ({ kind, expected }) => {
      const ids = makeIds();
      const messageId = `msg_seam_unbound_${kind}`;
      const session = await registerSeamSession(ids);
      const incarnation = `incarnation-seam-unbound-${kind}`;
      await runInDurableObject(session, async (_instance, state) => {
        writeSessionMessages(state.storage, { kind: 'unresolved' }, [
          kind === 'accepted'
            ? acceptedRow(ids, messageId)
            : {
                messageId,
                state: queuedState({
                  intent: {
                    turn: { type: 'prompt', messageId, prompt: 'held' },
                    agent: { mode: 'code' },
                  },
                  legacyInvalidIntent: undefined,
                  wrapperInstanceId: ids.wrapperInstanceId,
                }),
              },
        ]);
        await state.storage.put(ATTACHED_SESSION_KEY, {
          ownerId,
          sessionId: ids.sessionId,
          kiloSessionId: ids.kiloSessionId,
          directory: ids.directory,
          sandboxId: ids.sandboxId,
          wrapperInstanceId: ids.wrapperInstanceId,
          allocationIncarnation: incarnation,
        });
      });

      await runInDurableObject(session, async instance => {
        await expect(
          instance.notifyStopped({ reason: 'idle', stopProof: stopProof(ids, incarnation) })
        ).resolves.toEqual({ outcome: 'delivered' });
      });

      await runInDurableObject(session, async (_instance, state) => {
        const stored = readSessionValueSync(state.storage.kv) as
          | {
              v?: number;
              binding?: unknown;
              messages?: { messageId: string; state: { kind: string; reason?: string } }[];
            }
          | undefined;
        // The persisted envelope binding and the attachment must agree: both are
        // unbound/absent after allocation loss.
        expect(stored?.v).toBe(2);
        expect(stored?.binding).toEqual({ kind: 'unbound' });
        expect(stored?.messages?.[0]?.messageId).toBe(messageId);
        expect(stored?.messages?.[0]?.state).toMatchObject(expected);
        expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
      });
    }
  );

  it('binds fresh demand to a new allocation incarnation after a STOPPED', async () => {
    // Admission validates the model against the catalog; keep that reachable.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ valid: true }));
    const ids = makeIds();
    const stoppedMessageId = 'msg_seam_stop_old';
    const freshMessageId = 'msg_seam_fresh_new';
    const session = await registerSeamSession(ids);
    const stoppedIncarnation = 'incarnation-seam-stopped-old';
    await runInDurableObject(session, async (_instance, state) => {
      writeSessionMessages(state.storage, { kind: 'unresolved' }, [
        acceptedRow(ids, stoppedMessageId),
      ]);
      await state.storage.put(ATTACHED_SESSION_KEY, {
        ownerId,
        sessionId: ids.sessionId,
        kiloSessionId: ids.kiloSessionId,
        directory: ids.directory,
        sandboxId: ids.sandboxId,
        wrapperInstanceId: ids.wrapperInstanceId,
        allocationIncarnation: stoppedIncarnation,
      });
    });

    // STOPPED for the bound incarnation terminalizes the old turn and clears it.
    await runInDurableObject(session, async instance => {
      await expect(
        instance.notifyStopped({
          reason: 'idle',
          stopProof: stopProof(ids, stoppedIncarnation),
        })
      ).resolves.toEqual({ outcome: 'delivered' });
    });
    await runInDurableObject(session, async (_instance, state) => {
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({
        state: { kind: 'failed', reason: 'idle' },
      });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
    });

    // Fresh demand must allocate a distinct incarnation and bind the new message
    // to it instead of reusing the stopped one.
    const freshIncarnation = 'incarnation-seam-fresh-new';
    const freshWrapper = '33333333-3333-4333-8333-333333333333';
    const operations: string[] = [];
    const ensureReady = vi.fn(async () => ({
      allocationIncarnation: freshIncarnation,
      physical: 'running' as const,
      connection: 'ready' as const,
      wrapperInstanceId: freshWrapper,
      operationResults: true as const,
      attachment: {
        directory: ids.directory,
        env: { KILOCODE_TOKEN: 'control-token' },
        kilo: {
          scopeId: ids.sessionId,
          token: 'control-token',
          targets: {
            backendBaseUrl: 'https://backend.example.test',
            providerBaseUrl: 'https://provider.example.test',
            sessionIngestBaseUrl: 'https://ingest.example.test',
          },
        },
      },
    }));
    const control = {
      ensureReady,
      getStatus: async () => ({
        allocationIncarnation: freshIncarnation,
        physical: 'running' as const,
        connection: 'ready' as const,
        wrapperInstanceId: freshWrapper,
        operationResults: true as const,
      }),
      getRuntimeCredentialProxyFence: async () => null,
      attachSession: async () => ({}),
      request: async (request: { operation: string }) => {
        operations.push(request.operation);
        if (request.operation === 'session.attach')
          return {
            type: 'response' as const,
            requestId: 'attach',
            ok: true as const,
            result: { attached: true },
          };
        if (request.operation === 'session.prompt')
          return {
            type: 'response' as const,
            requestId: 'prompt',
            ok: true as const,
            result: { messageId: freshMessageId, status: 'accepted' },
          };
        return {
          type: 'response' as const,
          requestId: 'lookup',
          ok: true as const,
          result: { state: 'missing' },
        };
      },
    };

    await runInDurableObject(session, async instance => {
      const original = instance['env'].SANDBOX_CONTROL;
      instance['env'].SANDBOX_CONTROL = { getByName: () => control } as never;
      try {
        const admitted = await instance.admitSubmittedMessage({
          userId: ownerId,
          turn: { type: 'prompt', id: freshMessageId, prompt: 'fresh demand' },
        });
        expect(admitted.success).toBe(true);
        await instance['dispatchQueued'](freshMessageId, { allowCreate: true });
      } finally {
        instance['env'].SANDBOX_CONTROL = original;
      }
    });

    // The demand reached the allocation path (a fresh acquisition) rather than
    // reusing the stopped allocation, and the prompt was delivered on it.
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId, sessionId: ids.sessionId, provider: 'cloudflare' })
    );
    expect(operations).toContain('session.prompt');

    await runInDurableObject(session, async (_instance, state) => {
      const attachment = (await state.storage.get(ATTACHED_SESSION_KEY)) as
        | { wrapperInstanceId?: string; allocationIncarnation?: string }
        | undefined;
      expect(attachment).toMatchObject({
        wrapperInstanceId: freshWrapper,
        allocationIncarnation: freshIncarnation,
      });
      expect(attachment?.allocationIncarnation).not.toBe(stoppedIncarnation);
      const fresh = readRawSessionMessages(state.storage.kv).find(
        message => message.messageId === freshMessageId
      );
      expect(fresh).toMatchObject({
        state: { kind: 'accepted', wrapperInstanceId: freshWrapper },
      });
      // The persisted envelope binding names the new incarnation and wrapper.
      expect((readSessionValueSync(state.storage.kv) as { binding?: unknown }).binding).toEqual({
        kind: 'bound',
        handle: { incarnation: freshIncarnation, wrapper: freshWrapper, epoch: 0 },
      });
    });
  });

  it('recovers the incarnation for a persisted legacy dispatched prompt and accepts it without redispatch', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_upgrade_accept';
    const session = await registerSeamSession(ids);
    const authorization = legacyPromptAuthorization(ids, messageId);
    const executionDeadlineAt = Date.now() + 60_000;
    await seedLegacyDispatchedPrompt(session, ids, messageId, {
      authorization,
      executionDeadlineAt,
    });

    const { control, operations } = reconcileSessionControl(ids, {
      status: {
        allocationIncarnation: 'recovered-incarnation',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: ids.wrapperInstanceId,
      },
      operationState: 'running',
      authorization,
      executionDeadlineAt,
    });
    await runInDurableObject(session, async instance => {
      const original = instance['env'].SANDBOX_CONTROL;
      instance['env'].SANDBOX_CONTROL = { getByName: () => control } as never;
      try {
        await instance.alarm();
      } finally {
        instance['env'].SANDBOX_CONTROL = original;
      }
    });

    // The persisted legacy prompt is reconciled, never re-dispatched.
    expect(operations).toEqual(['session.operation.get']);
    await runInDurableObject(session, async (_instance, state) => {
      const [row] = readRawSessionMessages(state.storage.kv);
      expect(row).toMatchObject({
        state: { kind: 'accepted', wrapperInstanceId: ids.wrapperInstanceId },
      });
      const attachment = (await state.storage.get(ATTACHED_SESSION_KEY)) as
        | { allocationIncarnation?: string }
        | undefined;
      expect(attachment?.allocationIncarnation).toBe('recovered-incarnation');
      expect((readSessionValueSync(state.storage.kv) as { binding?: unknown }).binding).toEqual({
        kind: 'bound',
        handle: {
          incarnation: 'recovered-incarnation',
          wrapper: ids.wrapperInstanceId,
          epoch: 0,
        },
      });
    });
  });

  it('expires a persisted legacy dispatched prompt at its bound with an unbound envelope', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_upgrade_expiry';
    const session = await registerSeamSession(ids);
    const authorization = legacyPromptAuthorization(ids, messageId);
    const executionDeadlineAt = Date.now() + 1_000;
    await seedLegacyDispatchedPrompt(session, ids, messageId, {
      authorization,
      executionDeadlineAt,
    });

    // No wrapper is exposed, so the incarnation-less binding stays unresolved.
    const { control, operations } = reconcileSessionControl(ids, {
      status: { allocationIncarnation: 'live-incarnation' },
      operationState: 'running',
      authorization,
      executionDeadlineAt,
    });
    await runInDurableObject(session, async instance => {
      const original = instance['env'].SANDBOX_CONTROL;
      instance['env'].SANDBOX_CONTROL = { getByName: () => control } as never;
      try {
        await instance.alarm();
      } finally {
        instance['env'].SANDBOX_CONTROL = original;
      }
    });

    // The unresolved condition stays visible while the bound is still ahead.
    await runInDurableObject(session, async (_instance, state) => {
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({
        state: { kind: 'queued' },
      });
    });

    await new Promise(resolve => setTimeout(resolve, 1_100));
    await runInDurableObject(session, async instance => {
      await instance.alarm();
    });

    expect(operations).not.toContain('session.prompt');
    await runInDurableObject(session, async (_instance, state) => {
      const [row] = readRawSessionMessages(state.storage.kv);
      expect(row).toMatchObject({ state: { kind: 'failed', reason: 'prompt_exhausted' } });
      // It never failed before the execution bound; the alarm after the bound is
      // the one that terminalized it.
      expect(row?.state.kind === 'failed' ? row.state.at : undefined).toBeGreaterThanOrEqual(
        executionDeadlineAt
      );
      expect((readSessionValueSync(state.storage.kv) as { binding?: unknown }).binding).toEqual({
        kind: 'unbound',
      });
    });
  });

  it('settles a reconcilable legacy head with an unbound envelope and no redispatch', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_upgrade_settle';
    const session = await registerSeamSession(ids);
    const authorization = legacyPromptAuthorization(ids, messageId);
    const executionDeadlineAt = Date.now() + 60_000;
    await seedLegacyDispatchedPrompt(session, ids, messageId, {
      authorization,
      executionDeadlineAt,
    });

    // A live allocation exposing a different wrapper cannot adopt the legacy
    // head; the head settles instead of being re-dispatched.
    const { control, operations } = reconcileSessionControl(ids, {
      status: {
        allocationIncarnation: 'live-incarnation',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: 'different-wrapper',
      },
      operationState: 'running',
      authorization,
      executionDeadlineAt,
    });
    await runInDurableObject(session, async instance => {
      const original = instance['env'].SANDBOX_CONTROL;
      instance['env'].SANDBOX_CONTROL = { getByName: () => control } as never;
      try {
        await instance.alarm();
      } finally {
        instance['env'].SANDBOX_CONTROL = original;
      }
    });

    expect(operations).toEqual(['session.operation.get']);
    await runInDurableObject(session, async (_instance, state) => {
      const [row] = readRawSessionMessages(state.storage.kv);
      expect(row).toMatchObject({ state: { kind: 'failed', reason: 'environment_stopped' } });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
      expect((readSessionValueSync(state.storage.kv) as { binding?: unknown }).binding).toEqual({
        kind: 'unbound',
      });
    });
  });

  it('rolls back an attempted hydration when the commit lands on a stale epoch', async () => {
    const ids = makeIds();
    const session = await registerSeamSession(ids);
    const controlStub = env.SANDBOX_CONTROL.getByName(ids.sandboxId);
    await seedLegacyAttachment(session, ids, 'msg_seam_hydrate_epoch');
    const before = await runInDurableObject(session, async (_instance, state) => ({
      envelope: readSessionValueSync(state.storage.kv),
      attachment: await state.storage.get(ATTACHED_SESSION_KEY),
    }));

    await runInDurableObject(controlStub, instance => {
      const prototype = Object.getPrototypeOf(instance) as { getStatus: () => Promise<unknown> };
      // The resolver exposes the matching wrapper and a live incarnation, so the
      // incarnation is written into the attachment inside the transaction.
      vi.spyOn(prototype, 'getStatus').mockResolvedValueOnce({
        allocationIncarnation: 'resolved-incarnation',
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: ids.wrapperInstanceId,
      } as never);
    });

    await runInDurableObject(session, async instance => {
      const prototype = Object.getPrototypeOf(instance) as {
        saveMessagesInCurrentTransaction: (...args: unknown[]) => boolean;
      };
      const original = prototype.saveMessagesInCurrentTransaction.bind(instance);
      // A real epoch mismatch between decision and commit: the commit's own
      // `isCurrent` check rejects instead of a forced writer refusal.
      vi.spyOn(prototype, 'saveMessagesInCurrentTransaction').mockImplementationOnce(
        (messages, epoch, source, deferred) =>
          original(messages, typeof epoch === 'number' ? epoch + 1 : epoch, source, deferred)
      );
      await expect(
        instance.notifyStopped({
          reason: 'idle',
          stopProof: stopProof(ids, 'resolved-incarnation'),
        })
      ).resolves.toEqual({ outcome: 'failed', reason: 'stop_commit_rejected' });
    });

    await runInDurableObject(session, async (_instance, state) => {
      const [row] = readRawSessionMessages(state.storage.kv);
      expect(row).toMatchObject({ state: { kind: 'accepted' } });
      expect(readSessionValueSync(state.storage.kv)).toEqual(before.envelope);
      const attachment = (await state.storage.get(ATTACHED_SESSION_KEY)) as
        | { wrapperInstanceId?: string; allocationIncarnation?: string }
        | undefined;
      expect(attachment).toEqual(before.attachment);
      // The attempted hydration rolled back with the rejected commit.
      expect(attachment?.allocationIncarnation).toBeUndefined();
    });
  });

  it('clears the delivery identity and sibling cancellation on a stopped bound session', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_stop_clear';
    const session = await registerSeamSession(ids);
    const incarnation = 'incarnation-seam-clear';
    await runInDurableObject(session, async (_instance, state) => {
      writeSessionMessages(state.storage, { kind: 'unresolved' }, [
        {
          ...acceptedRow(ids, messageId),
          state: {
            ...acceptedState({
              wrapperInstanceId: ids.wrapperInstanceId,
              preparationAttemptId: 'attempt-seam-clear',
              acceptedAt: Date.now(),
              lastActivityAt: Date.now(),
              executionDeadlineAt: Date.now() + 60_000,
            }),
          },
          cancellation: { operationId: 'cancel-seam-clear', deadlineAt: Date.now() + 10 },
        },
      ]);
      await state.storage.put(ATTACHED_SESSION_KEY, {
        ownerId,
        sessionId: ids.sessionId,
        kiloSessionId: ids.kiloSessionId,
        directory: ids.directory,
        sandboxId: ids.sandboxId,
        wrapperInstanceId: ids.wrapperInstanceId,
        allocationIncarnation: incarnation,
      });
    });

    await runInDurableObject(session, async instance => {
      await expect(
        instance.notifyStopped({ reason: 'idle', stopProof: stopProof(ids, incarnation) })
      ).resolves.toEqual({ outcome: 'delivered' });
    });

    await runInDurableObject(session, async (_instance, state) => {
      const [row] = readRawSessionMessages(state.storage.kv);
      expect(row?.state).toMatchObject({ kind: 'failed', reason: 'idle' });
      expect(row?.state).not.toHaveProperty('wrapperInstanceId');
      expect(row?.state).not.toHaveProperty('preparationAttemptId');
      expect(row).not.toHaveProperty('cancellation');
      // The already-terminal sibling timestamp is preserved, not re-derived.
      expect(row?.state).toHaveProperty('at');
    });
  });

  it('schedules exactly one terminal callback/report repair across a replay', async () => {
    const ids = makeIds();
    const session = await registerSeamSession(ids);
    const incarnation = 'incarnation-seam-count';
    await seedLegacyAttachment(session, ids, 'msg_seam_count', {
      allocationIncarnation: incarnation,
    });

    const repairs = await countRepairs(session, async instance => {
      const proof = stopProof(ids, incarnation);
      await expect(instance.notifyStopped({ reason: 'idle', stopProof: proof })).resolves.toEqual({
        outcome: 'delivered',
      });
      await instance.notifyStopped({ reason: 'idle', stopProof: proof });
    });
    // No callback target is configured, so the terminal report repair is the
    // observable terminal event; it is scheduled exactly once across the replay.
    expect(repairs).toEqual({ callbacks: 0, reports: 1 });
  });

  it('persists and schedules a configured terminal callback across a replay', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_callback';
    const session = await registerSeamSession(ids, {
      callbackUrl: 'https://example.com/callback',
    });
    const incarnation = 'incarnation-seam-callback';
    await seedLegacyAttachment(session, ids, messageId, { allocationIncarnation: incarnation });

    const repairs = await countRepairs(session, async instance => {
      const proof = stopProof(ids, incarnation);
      await expect(instance.notifyStopped({ reason: 'idle', stopProof: proof })).resolves.toEqual({
        outcome: 'delivered',
      });
      await instance.notifyStopped({ reason: 'idle', stopProof: proof });
    });
    // A configured callback target turns the terminalization into a persisted
    // callback job, scheduled exactly once across the replay.
    expect(repairs).toEqual({ callbacks: 1, reports: 1 });
    await runInDurableObject(session, async (_instance, state) => {
      const pending = state.storage.kv.get(callbackOutboxKey(messageId)) as
        | { job: { target: { url: string }; payload: { status: string } } }
        | undefined;
      expect(pending?.job.target.url).toBe('https://example.com/callback');
      expect(pending?.job.payload.status).toBe('failed');
    });
  });

  it('rejects a stale incarnation without terminalizing the session', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_stale';
    const session = await registerSeamSession(ids);
    const incarnation = 'incarnation-seam-2';
    await runInDurableObject(session, async (_instance, state) => {
      writeSessionMessages(state.storage, { kind: 'unresolved' }, [acceptedRow(ids, messageId)]);
      await state.storage.put(ATTACHED_SESSION_KEY, {
        ownerId,
        sessionId: ids.sessionId,
        kiloSessionId: ids.kiloSessionId,
        directory: ids.directory,
        sandboxId: ids.sandboxId,
        wrapperInstanceId: ids.wrapperInstanceId,
        allocationIncarnation: incarnation,
      });
    });

    await runInDurableObject(session, async instance => {
      await instance.notifyStopped({
        reason: 'idle',
        stopProof: stopProof(ids, 'incarnation-stale'),
      });
    });

    await runInDurableObject(session, async (_instance, state) => {
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({
        state: { kind: 'accepted' },
      });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeDefined();
    });
  });

  it.each(['cancel', 'idle'] as const)(
    'notifies attached sessions immediately on %s while provider stop is pending, exactly once',
    async reason => {
      const ids = makeIds();
      const messageId = `msg_seam_${reason}`;
      const session = await registerSeamSession(ids);

      const controlStub = env.SANDBOX_CONTROL.getByName(ids.sandboxId);
      let releaseStop: () => void = () => undefined;
      const stopGate = new Promise<void>(resolve => {
        releaseStop = resolve;
      });
      let stopping: Promise<unknown> | undefined;
      const incarnation = await runInDurableObject(controlStub, async (instance, state) => {
        const provider = createMemoryProviderAdapter();
        const originalStop = provider.stop.bind(provider);
        provider.stop = async (ref, intent) => {
          await stopGate;
          return originalStop(ref, intent);
        };
        Object.assign(instance, {
          provider,
          createProviderAdapter: () => provider,
          providerKind: 'cloudflare',
        });
        await instance.initializeOwner(ownerId);
        const providerRef = encodeCloudflareProviderRef({
          sandboxId: ids.sandboxId,
          containment: true,
          instanceId: 'cancel-intent',
        });
        await seedCanonicalRunning(state.storage, providerRef, {
          provider: 'cloudflare',
          intentId: `${reason}-intent`,
          allocationName: ids.sandboxId,
          health: 'healthy',
          // The idle case must stop through the canonical idle deadline, not a
          // direct `beginStop`.
          ...(reason === 'idle' ? { idleAt: Date.now() - 1 } : {}),
        });
        const record = await readCanonicalAllocationRecord(state.storage);
        if (record?.state.kind !== 'allocated') throw new Error('Missing allocated fixture');
        return record.state.health.incarnation;
      });

      await runInDurableObject(session, async (_instance, state) => {
        writeSessionMessages(state.storage, { kind: 'unresolved' }, [acceptedRow(ids, messageId)]);
        await state.storage.put(ATTACHED_SESSION_KEY, {
          ownerId,
          sessionId: ids.sessionId,
          kiloSessionId: ids.kiloSessionId,
          directory: ids.directory,
          sandboxId: ids.sandboxId,
          wrapperInstanceId: ids.wrapperInstanceId,
          allocationIncarnation: incarnation,
        });
      });

      let callbacks = 0;
      let reports = 0;
      await runInDurableObject(session, instance => {
        const prototype = Object.getPrototypeOf(instance) as {
          scheduleCallbackRepair: () => void;
          scheduleReportRepair: () => void;
        };
        vi.spyOn(prototype, 'scheduleCallbackRepair').mockImplementation(() => {
          callbacks += 1;
        });
        vi.spyOn(prototype, 'scheduleReportRepair').mockImplementation(() => {
          reports += 1;
        });
      });

      await runInDurableObject(controlStub, async (instance, state) => {
        const table = emptyRouteTable();
        attachRoute(
          table,
          {
            sessionId: ids.sessionId,
            kiloSessionId: ids.kiloSessionId,
            directory: ids.directory,
            ownerId,
          },
          ownerId
        );
        await saveRouteTable(state.storage, table);
        stopping = reason === 'idle' ? instance.alarm() : instance.beginStop(reason);
      });

      // The notification reaches the session before the provider stop resolves.
      await vi.waitFor(async () => {
        const messages = await runInDurableObject(session, async (_instance, sessionState) =>
          readRawSessionMessages(sessionState.storage.kv)
        );
        expect(messages[0]).toMatchObject({ state: { kind: 'failed', reason: reason } });
      });

      releaseStop();
      await stopping;
      await runInDurableObject(controlStub, async instance => {
        await instance.confirmStopped();
      });

      // The confirmation replays the notification; terminalization and its
      // callback/report repair happen exactly once.
      await runInDurableObject(session, async (_instance, state) => {
        const messages = readRawSessionMessages(state.storage.kv);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ state: { kind: 'failed', reason: reason } });
        expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
      });
      // One terminal report repair; the confirmation replay adds none.
      expect({ callbacks, reports }).toEqual({ callbacks: 0, reports: 1 });
    }
  );

  it('discards a delayed legacy resolution after the attachment is rebound', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_delayed_rebind';
    const session = await registerSeamSession(ids);
    await seedLegacyAttachment(session, ids, messageId);

    await runInDurableObject(session, async (instance, state) => {
      const gate = Promise.withResolvers<void>();
      const prototype = Object.getPrototypeOf(instance) as {
        resolveLegacyStopAttachment: () => Promise<unknown>;
      };
      let began: () => void = () => undefined;
      const started = new Promise<void>(resolve => {
        began = resolve;
      });
      vi.spyOn(prototype, 'resolveLegacyStopAttachment').mockImplementationOnce(async () => {
        began();
        await gate.promise;
        return { kind: 'settle' };
      });

      const notified = instance.notifyStopped({
        reason: 'idle',
        stopProof: stopProof(ids, 'stale-incarnation'),
      });
      await started;
      // Concurrent rebind to a different wrapper while the resolver is in flight.
      await state.storage.put(ATTACHED_SESSION_KEY, {
        ownerId,
        sessionId: ids.sessionId,
        kiloSessionId: ids.kiloSessionId,
        directory: ids.directory,
        sandboxId: ids.sandboxId,
        wrapperInstanceId: 'rebound-wrapper',
      });
      gate.resolve();
      await notified;

      // The stale resolver result is discarded: the new binding is intact and
      // the accepted row was not terminalized.
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({
        state: { kind: 'accepted' },
      });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toMatchObject({
        wrapperInstanceId: 'rebound-wrapper',
      });
    });
  });

  it('retries an unresolved legacy resolution without clearing the attachment', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_unresolved_retry';
    const session = await registerSeamSession(ids);
    const controlStub = env.SANDBOX_CONTROL.getByName(ids.sandboxId);
    await seedLegacyAttachment(session, ids, messageId);

    // A live incarnation with no exposed wrapper is indeterminate: the resolver
    // must not invent a match and must report a retryable failure.
    await runInDurableObject(controlStub, instance => {
      const prototype = Object.getPrototypeOf(instance) as { getStatus: () => Promise<unknown> };
      vi.spyOn(prototype, 'getStatus').mockResolvedValueOnce({
        allocationIncarnation: 'live-incarnation',
      } as never);
    });

    const first = await runInDurableObject(session, instance =>
      instance.notifyStopped({ reason: 'idle', stopProof: stopProof(ids, 'retry-incarnation') })
    );
    expect(first).toEqual({ outcome: 'failed', reason: 'stop_attachment_unresolved' });
    await runInDurableObject(session, async (_instance, state) => {
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({
        state: { kind: 'accepted' },
      });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeDefined();
    });

    // A re-delivery with the control reachable settles the same legacy record.
    const second = await runInDurableObject(session, instance =>
      instance.notifyStopped({ reason: 'idle', stopProof: stopProof(ids, 'retry-incarnation') })
    );
    expect(second).toEqual({ outcome: 'delivered' });
    await runInDurableObject(session, async (_instance, state) => {
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({
        state: { kind: 'failed', reason: 'idle' },
      });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
    });
  });

  it('rejects a stale proof against a concurrently hydrated binding', async () => {
    const ids = makeIds();
    const messageId = 'msg_seam_held_hydrate';
    const session = await registerSeamSession(ids);
    await seedLegacyAttachment(session, ids, messageId);

    await runInDurableObject(session, async (instance, state) => {
      const gate = Promise.withResolvers<void>();
      const prototype = Object.getPrototypeOf(instance) as {
        resolveLegacyStopAttachment: () => Promise<unknown>;
      };
      let began: () => void = () => undefined;
      const started = new Promise<void>(resolve => {
        began = resolve;
      });
      vi.spyOn(prototype, 'resolveLegacyStopAttachment').mockImplementationOnce(async () => {
        began();
        await gate.promise;
        return { kind: 'hydrate', incarnation: 'old-incarnation' };
      });

      const notified = instance.notifyStopped({
        reason: 'idle',
        stopProof: stopProof(ids, 'old-incarnation'),
      });
      await started;
      // A concurrent credential-refresh attachment hydrates a *new* incarnation.
      await state.storage.put(ATTACHED_SESSION_KEY, {
        ownerId,
        sessionId: ids.sessionId,
        kiloSessionId: ids.kiloSessionId,
        directory: ids.directory,
        sandboxId: ids.sandboxId,
        wrapperInstanceId: ids.wrapperInstanceId,
        allocationIncarnation: 'new-incarnation',
      });
      gate.resolve();
      await notified;

      // The proof is fenced by the current incarnation, so the fresh binding and
      // its accepted row are untouched.
      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({
        state: { kind: 'accepted' },
      });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toMatchObject({
        allocationIncarnation: 'new-incarnation',
      });
    });
  });

  it('keeps the binding when the stop write is rejected for the current epoch', async () => {
    const ids = makeIds();
    const session = await registerSeamSession(ids);
    const controlStub = env.SANDBOX_CONTROL.getByName(ids.sandboxId);
    await seedLegacyAttachment(session, ids, 'msg_seam_epoch_reject');
    const before = await runInDurableObject(session, async (_instance, state) => ({
      envelope: readSessionValueSync(state.storage.kv),
      attachment: await state.storage.get(ATTACHED_SESSION_KEY),
    }));

    await runInDurableObject(controlStub, instance => {
      const prototype = Object.getPrototypeOf(instance) as { getStatus: () => Promise<unknown> };
      // An incarnation-less legacy binding against an allocation with no exposed
      // incarnation settles through the resolver.
      vi.spyOn(prototype, 'getStatus').mockResolvedValueOnce({} as never);
    });

    await runInDurableObject(session, async instance => {
      const prototype = Object.getPrototypeOf(instance) as {
        saveMessagesInCurrentTransaction: (...args: unknown[]) => boolean;
      };
      // Simulate a concurrent lifecycle advance: the writer rejects the commit
      // for the epoch this notification captured.
      vi.spyOn(prototype, 'saveMessagesInCurrentTransaction').mockReturnValueOnce(false);
      await expect(
        instance.notifyStopped({ reason: 'idle', stopProof: undefined })
      ).resolves.toEqual({ outcome: 'failed', reason: 'stop_commit_rejected' });
    });

    await runInDurableObject(session, async (_instance, state) => {
      // A rejected write must not orphan the binding or terminalize the row: the
      // original envelope and the incarnation-less attachment both survive, and
      // no incarnation was hydrated onto the record.
      const [row] = readRawSessionMessages(state.storage.kv);
      expect(row).toMatchObject({ state: { kind: 'accepted' } });
      expect(readSessionValueSync(state.storage.kv)).toEqual(before.envelope);
      const attachment = (await state.storage.get(ATTACHED_SESSION_KEY)) as
        | { wrapperInstanceId?: string; allocationIncarnation?: string }
        | undefined;
      expect(attachment).toEqual(before.attachment);
      expect(attachment?.allocationIncarnation).toBeUndefined();
    });
  });

  it('discards a delayed settlement after the attachment is deleted', async () => {
    const ids = makeIds();
    const session = await registerSeamSession(ids);
    await seedLegacyAttachment(session, ids, 'msg_seam_delayed_delete');

    await runInDurableObject(session, async (instance, state) => {
      const gate = Promise.withResolvers<void>();
      const prototype = Object.getPrototypeOf(instance) as {
        resolveLegacyStopAttachment: () => Promise<unknown>;
      };
      let began: () => void = () => undefined;
      const started = new Promise<void>(resolve => {
        began = resolve;
      });
      vi.spyOn(prototype, 'resolveLegacyStopAttachment').mockImplementationOnce(async () => {
        began();
        await gate.promise;
        return { kind: 'settle' };
      });

      const notified = instance.notifyStopped({ reason: 'idle', stopProof: undefined });
      await started;
      // Concurrent deletion removes the binding while the resolver is in flight.
      await state.storage.delete(ATTACHED_SESSION_KEY);
      gate.resolve();
      await notified;

      expect(readRawSessionMessages(state.storage.kv)[0]).toMatchObject({
        state: { kind: 'accepted' },
      });
      expect(await state.storage.get(ATTACHED_SESSION_KEY)).toBeUndefined();
    });
  });
});
