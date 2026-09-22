/**
 * Workers-runtime regression coverage for the runtime credential proxy control
 * fence across a recovery-capable wrapper reconnect.
 *
 * The defect fixed by commit 921e76abc9: the fence backing
 * `getRuntimeCredentialProxyFence` was sourced from the ready wrapper runtime, so
 * a recovery-capable control close - which deliberately keeps the wrapper
 * incarnation but drops readiness - made the fence resolve to null for the whole
 * reconnect window. A persisted runtime proxy grant then stopped resolving and
 * the proxy returned HTTP 401 until a new socket became ready.
 *
 * This file drives the real Miniflare Workers runtime: real SandboxControl and
 * SandboxSession Durable Objects, real SQLite storage, real control WebSockets,
 * and the real recovery reconcile. Node-level unit coverage lives in
 * `src/runtime-credential-proxy.test.ts`, `src/runtime-credential-proxy-rpc.test.ts`,
 * `src/sandbox-control/lifecycle.test.ts`, and
 * `src/sandbox-session/session-message-queue.test.ts`.
 *
 * Not reachable here: the HTTP proxy route itself. The Workers-pool test entry
 * does not mount the Hono app, so `SELF.fetch('/api/runtime-credential-proxy/...')`
 * returns the test worker's own 404. The grant tests assert the exact RPC the
 * proxy route calls, `resolveRuntimeCredentialProxyGrant`, which is the same read
 * that returned null (and produced the 401) before the fix.
 *
 * Provider-instance and allocation replacement are not exercised in this file.
 * They require a separate replacement-lifecycle scenario; identity-mutation cases
 * remain covered by the Node-level unit tests.
 */
import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from './wait-for.js';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import type {
  AttachSessionInput,
  ControlRuntimeCredentialProxyFence,
  SandboxControl,
} from '../../src/persistence/SandboxControl.js';
import { resolveSecret } from '../../src/auth.js';
import { DEADLINE_MS } from '../../src/sandbox-control/deadlines.js';
import { encodeCloudflareProviderRef } from '../../src/sandbox-control/cloudflare-provider.js';
import { WORKTREE_CREDENTIAL_CONTAINMENT } from '../../src/sandbox-control/physical-lifecycle.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
} from '../../src/sandbox-control/credential.js';
import { createControlPlaneCredential } from '../../src/sandbox-control/managed-credential.js';
import { sessionCredentialGrantSchema } from '../../src/sandbox-control/session-credentials.js';
import { attachRoute } from '../../src/sandbox-control/session-routes.js';
import {
  loadSessionCredentialGrants,
  savePhysicalRecord,
  saveRouteTable,
  saveSessionCredentialGrants,
} from '../../src/sandbox-control/durable-state.js';
import { RUNTIME_AUTHORIZATION_KEY } from '../../src/session/runtime-authorization-persistence.js';
import { RUNTIME_PROXY_GRANT_KEY } from '../../src/runtime-credential-proxy.js';

const OWNER_ID = 'github|oauth:runtime-reconnect/1';
// Below Vitest's 5s default test timeout, so a stalled runtime transition fails
// on the wait assertion instead of a generic test timeout.
const RECONNECT_TIMEOUT_MS = 4_000;
const CONTAINMENT_TARGETS = {
  backendBaseUrl: 'https://api.kilo.ai',
  providerBaseUrl: 'https://provider.kilo.ai',
  sessionIngestBaseUrl: 'https://ingest.kilo.ai',
};

type SandboxControlStub = ReturnType<(typeof env.SANDBOX_CONTROL)['getByName']>;
type SandboxSessionStub = ReturnType<(typeof env.SANDBOX_SESSION)['getByName']>;

type RuntimeFixture = {
  sandboxId: string;
  sessionId: string;
  kiloSessionId: string;
  directory: string;
  authorizationId: string;
  credential: string;
  providerRef: string;
  control: SandboxControlStub;
  session: SandboxSessionStub;
};

type InboundRequest = { type: string; requestId: string; operation: string; payload?: unknown };

function cloudflareRef(sandboxId: string, instanceId = 'inst_1'): string {
  return encodeCloudflareProviderRef({ sandboxId, containment: true, instanceId });
}

function fakeProvider() {
  return {
    resumable: false,
    async ensureBillingAdmission() {},
    async create() {
      return { unresolved: true };
    },
    async launch() {},
    async observe() {
      return { status: 'active' };
    },
    async stop() {
      return 'terminal';
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
    async updateNetworkPolicy() {},
  };
}

async function seedRunningCloudflare(instance: SandboxControl): Promise<string> {
  const providerRef = cloudflareRef(instance.sandboxId);
  const physical = await instance.getPhysicalRecord();
  if (physical.state === 'stopped') {
    await instance.claimCreate(
      'inst_1',
      false,
      instance.sandboxId,
      WORKTREE_CREDENTIAL_CONTAINMENT
    );
  }
  if (physical.state !== 'running') await instance.confirmInstance(providerRef);
  const running = await instance.getPhysicalRecord();
  if (!running.createIntent) throw new Error('Missing fixture create intent');
  await savePhysicalRecord(instance['ctx'].storage, {
    ...running,
    createIntent: {
      ...running.createIntent,
      createdAt: Date.now() - DEADLINE_MS.createSettle - 1,
    },
  });
  Object.assign(instance, { provider: fakeProvider() });
  return providerRef;
}

async function seedGrant(
  instance: SandboxControl,
  state: DurableObjectState,
  input: AttachSessionInput
): Promise<void> {
  const now = Date.now();
  const grant = sessionCredentialGrantSchema.parse({
    version: 1,
    scopeId: input.worktreeId ?? input.sessionId,
    sandboxId: instance.sandboxId,
    directory: input.directory,
    userId: input.ownerId,
    provider: 'cloudflare',
    outboundContainerId: `contained:${instance.sandboxId}`,
    members: [{ sessionId: input.sessionId, kiloSessionId: input.kiloSessionId }],
    kilo: {
      alias: createControlPlaneCredential(instance.sandboxId, 'kilo'),
      token: 'fixture-real-kilo-token',
      targets: CONTAINMENT_TARGETS,
      capabilities: {},
    },
    preparedAt: now,
    expiresAt: now + 4 * 60 * 60 * 1000,
  });
  await state.storage.transaction(async () => {
    await saveSessionCredentialGrants(state.storage, [
      ...(await loadSessionCredentialGrants(state.storage)).filter(
        value => !value.members.some(member => member.sessionId === input.sessionId)
      ),
      grant,
    ]);
  });
}

/**
 * Seeds one isolated sandbox allocation with a real running physical record, a
 * session credential grant, a route, and a registered SandboxSession carrying an
 * active RuntimeAuthorization. Every id is unique per call so tests never share
 * Durable Object state or depend on suite ordering.
 */
async function createFixture(): Promise<RuntimeFixture> {
  const sandboxId = `sbx__runtime_reconnect_${crypto.randomUUID()}`;
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
  const directory = `/workspace/runtime-reconnect-${crypto.randomUUID()}`;
  const authorizationId = crypto.randomUUID();
  const credential = generateSandboxCredential();
  const control = env.SANDBOX_CONTROL.getByName(sandboxId);
  const session = env.SANDBOX_SESSION.getByName(`${OWNER_ID}:${sessionId}`);

  await runInDurableObject(control, async instance => {
    await instance.initializeOwner(OWNER_ID);
    await instance.ctx.storage.put('provider_kind', 'cloudflare');
    if ((await instance.getPhysicalRecord()).state === 'stopped') {
      await instance.claimCreate('inst_1', false, sandboxId, WORKTREE_CREDENTIAL_CONTAINMENT);
    }
    await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
  });

  const providerRef = await runInDurableObject(control, async (instance, state) => {
    const ref = await seedRunningCloudflare(instance);
    const attach: AttachSessionInput = { sessionId, kiloSessionId, directory, ownerId: OWNER_ID };
    await seedGrant(instance, state, attach);
    await saveRouteTable(state.storage, attachRoute(new Map(), attach, OWNER_ID).table);
    return ref;
  });

  await runInDurableObject(session, async instance => {
    const secret = await resolveSecret(env.NEXTAUTH_SECRET);
    if (!secret) throw new Error('Missing integration test secret');
    const token = jwt.sign(
      { runtimeAuthorization: { id: authorizationId }, exp: Math.floor(Date.now() / 1000) + 3600 },
      secret
    );
    const authorization: RuntimeAuthorization = {
      version: 1,
      id: authorizationId,
      resourceKind: 'cloud-agent-next',
      resourceId: sessionId,
      userId: OWNER_ID,
      authorizationUserId: OWNER_ID,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      delegationExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      state: 'active',
      bindings: {
        userPepperDigest: 'a'.repeat(64),
        authorizationPepperDigest: 'b'.repeat(64),
        userMembershipId: 'membership_1',
        authorizationUserMembershipId: 'membership_1',
      },
      source: { admissionSource: 'user' },
    };
    instance.ctx.storage.kv.put(RUNTIME_AUTHORIZATION_KEY, authorization);
    const registered = await instance.registerSession({
      identity: { sessionId, userId: OWNER_ID },
      auth: { kiloSessionId, kilocodeToken: token },
      agent: { mode: 'code', model: 'anthropic/claude-sonnet-4' },
      workspace: { sandboxId, workspacePath: directory, branchName: 'runtime-reconnect' },
    });
    expect(registered).toEqual({ success: true });
  });

  return {
    sandboxId,
    sessionId,
    kiloSessionId,
    directory,
    authorizationId,
    credential,
    providerRef,
    control,
    session,
  };
}

async function connect(credential: string, sandboxId: string): Promise<WebSocket> {
  const response = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${credential}` },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Unexpected sandbox control upgrade: ${response.status}`);
  }
  response.webSocket.accept();
  return response.webSocket;
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };
    const onMessage = (event: MessageEvent) => {
      cleanup();
      resolve(typeof event.data === 'string' ? event.data : String(event.data));
    };
    const onError = () => {
      cleanup();
      reject(new Error('sandbox control websocket error'));
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(new Error(`sandbox control websocket closed: ${event.code}`));
    };
    ws.addEventListener('message', onMessage, { once: true });
    ws.addEventListener('error', onError, { once: true });
    ws.addEventListener('close', onClose, { once: true });
  });
}

/**
 * The shared `completeHello` helpers in this suite cannot express
 * `capabilities.connectionRecovery: true`, which is the exact capability this
 * test needs, so this file keeps its own recovery-capable hello.
 */
async function recoveryHello(
  ws: WebSocket,
  requestId: string,
  providerInstanceId: string,
  wrapperInstanceId: string
): Promise<void> {
  ws.send(
    JSON.stringify({
      type: 'request',
      requestId,
      operation: 'sandbox.hello',
      payload: {
        protocolVersion: 1,
        providerInstanceId,
        wrapperInstanceId,
        capabilities: {
          connectionRecovery: true,
          sessionOperationResults: true,
          nativeRuntimeRetirement: true,
          eventBatches: true,
          eventReceipts: true,
        },
      },
    })
  );
  const hello = JSON.parse(await nextMessage(ws)) as { requestId: string; ok: boolean };
  expect(hello).toMatchObject({ requestId, ok: true });
  const status = JSON.parse(await nextMessage(ws)) as InboundRequest;
  expect(status).toMatchObject({ type: 'request', operation: 'sandbox.status' });
  ws.send(JSON.stringify({ type: 'response', requestId: status.requestId, ok: true }));
}

/** Answers the recovery reconcile the DO drives after `sandbox.ready`. */
function installReconcileResponder(ws: WebSocket, phases: string[]): void {
  ws.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)) as InboundRequest;
    if (frame.type !== 'request') return;
    if (frame.operation === 'sandbox.reconcile') {
      const payload = frame.payload as {
        recovery: { episodeId: string; attempt: number };
        phase: 'drain' | 'ready' | 'commit';
      };
      phases.push(`reconcile:${payload.phase}`);
      ws.send(
        JSON.stringify({
          type: 'response',
          requestId: frame.requestId,
          ok: true,
          result: {
            episodeId: payload.recovery.episodeId,
            attempt: payload.recovery.attempt,
            phase: payload.phase,
          },
        })
      );
      return;
    }
    if (frame.operation === 'sandbox.status') {
      phases.push('status');
      ws.send(
        JSON.stringify({
          type: 'response',
          requestId: frame.requestId,
          ok: true,
          result: { healthy: true, state: 'idle', version: '2.4.0', kiloReady: true },
        })
      );
    }
  });
}

function signalReady(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: 'event',
      event: 'sandbox.ready',
      payload: { kiloReady: true, globalFeedAttached: true },
    })
  );
}

/** Connects, completes a recovery-capable hello, and drives readiness to commit. */
async function connectReadyRecoveryWrapper(
  fixture: RuntimeFixture,
  wrapperInstanceId: string
): Promise<{ socket: WebSocket; phases: string[] }> {
  const socket = await connect(fixture.credential, fixture.sandboxId);
  await recoveryHello(socket, 'hello_1', fixture.providerRef, wrapperInstanceId);
  const phases: string[] = [];
  installReconcileResponder(socket, phases);
  signalReady(socket);
  await waitFor(
    async () => {
      expect((await connectionState(fixture)).connection).toBe('ready');
    },
    { timeout: RECONNECT_TIMEOUT_MS }
  );
  return { socket, phases };
}

async function waitForDisconnected(fixture: RuntimeFixture): Promise<void> {
  await waitFor(
    async () => {
      expect((await connectionState(fixture)).connection).toBe('disconnected');
    },
    { timeout: RECONNECT_TIMEOUT_MS }
  );
}

async function fence(fixture: RuntimeFixture): Promise<ControlRuntimeCredentialProxyFence | null> {
  return runInDurableObject(fixture.control, instance =>
    instance.getRuntimeCredentialProxyFence({
      ownerId: OWNER_ID,
      sessionId: fixture.sessionId,
      kiloSessionId: fixture.kiloSessionId,
      directory: fixture.directory,
    })
  );
}

function controlFence(
  value: ControlRuntimeCredentialProxyFence | null
): ControlRuntimeCredentialProxyFence {
  if (!value) throw new Error('Expected a control runtime credential proxy fence');
  return value;
}

async function connectionState(fixture: RuntimeFixture) {
  return runInDurableObject(fixture.control, instance => instance.getStatus());
}

async function issueGrant(fixture: RuntimeFixture): Promise<string | null> {
  return runInDurableObject(fixture.session, instance =>
    instance.issueRuntimeCredentialProxyGrant({
      wrapperRunId: crypto.randomUUID(),
      wrapperGeneration: 1,
      wrapperConnectionId: crypto.randomUUID(),
    })
  );
}

async function resolveGrant(fixture: RuntimeFixture, handle: string) {
  return runInDurableObject(fixture.session, instance =>
    instance.resolveRuntimeCredentialProxyGrant(handle)
  );
}

async function persistedGrantConnectionId(fixture: RuntimeFixture): Promise<string | undefined> {
  return runInDurableObject(fixture.session, async instance => {
    const stored = await instance.ctx.storage.get<{ connectionId?: string }>(
      RUNTIME_PROXY_GRANT_KEY
    );
    return stored?.connectionId;
  });
}

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe('runtime credential proxy fence across a real control reconnect', () => {
  it('keeps the fence across a recovery-capable close and follows the reconnect connectionId', async () => {
    const fixture = await createFixture();
    const wrapperInstanceId = crypto.randomUUID();
    const { socket, phases } = await connectReadyRecoveryWrapper(fixture, wrapperInstanceId);

    // Readiness committed through the real recovery reconcile, not a mock.
    expect(phases).toEqual(
      expect.arrayContaining(['reconcile:drain', 'reconcile:ready', 'reconcile:commit'])
    );

    const ready = controlFence(await fence(fixture));
    expect(ready).toMatchObject({
      plane: 'control',
      providerInstanceId: fixture.providerRef,
      wrapperInstanceId,
    });
    expect(ready.allocationId).toBeTruthy();

    socket.close();
    await waitForDisconnected(fixture);

    // Defect boundary: a recovery-capable close keeps the established
    // incarnation, so the fence must still resolve with the same identity.
    await expect(fence(fixture)).resolves.toEqual(ready);

    const socket2 = await connect(fixture.credential, fixture.sandboxId);
    await recoveryHello(socket2, 'hello_2', fixture.providerRef, wrapperInstanceId);

    const reconnected = controlFence(await fence(fixture));
    expect(reconnected).toMatchObject({
      plane: 'control',
      allocationId: ready.allocationId,
      providerInstanceId: fixture.providerRef,
      wrapperInstanceId,
    });
    expect(reconnected.connectionId).not.toBe(ready.connectionId);
  });

  it('invalidates the fence when the wrapper incarnation changes', async () => {
    const fixture = await createFixture();
    const wrapperInstanceId = crypto.randomUUID();
    const socket = await connect(fixture.credential, fixture.sandboxId);
    await recoveryHello(socket, 'hello_1', fixture.providerRef, wrapperInstanceId);
    expect(controlFence(await fence(fixture)).wrapperInstanceId).toBe(wrapperInstanceId);

    const replacement = await connect(fixture.credential, fixture.sandboxId);
    await recoveryHello(replacement, 'hello_2', fixture.providerRef, crypto.randomUUID()).catch(
      error => {
        // Replacing the incarnation quarantines the runtime and closes the new
        // socket; that close is the expected replacement outcome, not a failure.
        if (!String(error).includes('closed: 4001')) throw error;
      }
    );

    await waitFor(
      async () => {
        expect(await fence(fixture)).toBeNull();
      },
      { timeout: RECONNECT_TIMEOUT_MS }
    );
  });

  it('invalidates the fence when the runtime stops', async () => {
    const fixture = await createFixture();
    const wrapperInstanceId = crypto.randomUUID();
    const socket = await connect(fixture.credential, fixture.sandboxId);
    await recoveryHello(socket, 'hello_1', fixture.providerRef, wrapperInstanceId);
    expect(controlFence(await fence(fixture)).wrapperInstanceId).toBe(wrapperInstanceId);

    await runInDurableObject(fixture.control, instance => instance.beginStop('idle'));
    await runInDurableObject(fixture.control, instance => instance.recordStopAttempt());

    await waitFor(
      async () => {
        expect(await fence(fixture)).toBeNull();
      },
      { timeout: RECONNECT_TIMEOUT_MS }
    );
  });

  it('keeps a persisted control grant resolving across the reconnect window and refreshes its dispatch pin', async () => {
    const fixture = await createFixture();
    const wrapperInstanceId = crypto.randomUUID();
    const { socket } = await connectReadyRecoveryWrapper(fixture, wrapperInstanceId);

    const handle = await issueGrant(fixture);
    expect(handle).toBeTruthy();
    if (!handle) throw new Error('Runtime credential proxy grant issuance failed');
    const ready = controlFence(await fence(fixture));
    await expect(resolveGrant(fixture, handle)).resolves.not.toBeNull();

    socket.close();
    await waitForDisconnected(fixture);

    // The reconnect window is exactly where the pre-fix fence went null and the
    // proxy returned HTTP 401 for an already issued handle.
    await expect(resolveGrant(fixture, handle)).resolves.not.toBeNull();

    const socket2 = await connect(fixture.credential, fixture.sandboxId);
    await recoveryHello(socket2, 'hello_2', fixture.providerRef, wrapperInstanceId);
    const reconnected = controlFence(await fence(fixture));
    expect(reconnected.connectionId).not.toBe(ready.connectionId);

    const resolved = await resolveGrant(fixture, handle);
    expect(resolved).not.toBeNull();
    expect(resolved?.runtimeAuthorization.authorizationId).toBe(fixture.authorizationId);

    // Re-issuing reuses the durable grant and refreshes the persisted dispatch pin.
    expect(await issueGrant(fixture)).toBe(handle);
    expect(await persistedGrantConnectionId(fixture)).toBe(reconnected.connectionId);
  });
});
