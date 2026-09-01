import {
  SELF,
  abortAllDurableObjects,
  env,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingContext } from '@kilocode/container-usage';
import {
  forceDestroyControlPlaneSandbox,
  SANDBOX_USAGE_SKUS,
  type SandboxBillingInput,
} from '../../src/container-usage-context.js';
import type {
  VercelSandboxNetworkPolicy,
  VercelSandboxSession,
} from '../../src/agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import { parseVercelSandboxRuntimeConfig } from '../../src/agent-sandbox/vercel/vercel-runtime-config.js';
import { TRPCError } from '@trpc/server';
import { router } from '../../src/router/auth.js';
import { createSessionManagementHandlers } from '../../src/router/handlers/session-management.js';
import { requireCurrentSessionAccess } from '../../src/session-access.js';
import type {
  AgentSelectionOverride,
  SubmittedSessionMessageRequest,
} from '../../src/execution/types.js';
import type { AttachSessionInput, SandboxControl } from '../../src/persistence/SandboxControl.js';
import {
  serializeSessionMetadata,
  type SessionMetadata,
} from '../../src/persistence/session-metadata.js';
import {
  createCloudflareProviderAdapter,
  decodeCloudflareProviderRef,
  encodeCloudflareProviderRef,
  type CloudflareSandboxHandle,
} from '../../src/sandbox-control/cloudflare-provider.js';
import { createControlPlaneCredential } from '../../src/sandbox-control/managed-credential.js';
import {
  buildControlNetworkPolicy,
  sessionCredentialGrantSchema,
  type SessionCredentialGrant,
} from '../../src/sandbox-control/session-credentials.js';
import { findMatchingCredentialInjectionRule } from '../../src/sandbox-control/vercel-network-policy.js';
import { MANAGED_SCM_OUTBOUND_HANDLER } from '../../src/sandbox-id.js';
import type { SandboxSession } from '../../src/sandbox-session/SandboxSession.js';
import {
  SANDBOX_SESSION_LIFECYCLE_KEY,
  SANDBOX_SESSION_METADATA_KEY,
} from '../../src/sandbox-session/terminal-lifecycle.js';
import type { AgentSandboxProvider, Env, GitTokenService, SandboxId } from '../../src/types.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
} from '../../src/sandbox-control/credential.js';
import {
  DEADLINE_MS,
  type DeadlineId,
  type DeadlineTable,
} from '../../src/sandbox-control/deadlines.js';
import type { VercelProviderLocator } from '../../src/sandbox-control/vercel-provider.js';
import {
  loadDeadlines,
  loadRouteTable,
  loadSessionCredentialGrants,
  saveDeadlines,
  savePhysicalRecord,
  saveRouteTable,
  saveSessionCredentialGrants,
} from '../../src/sandbox-control/durable-state.js';
import {
  beginStop,
  claimCreate,
  confirmRunning,
  initialPhysicalRecord,
  WORKTREE_CREDENTIAL_CONTAINMENT,
  type CredentialContainmentRequirements,
  type PhysicalRecord,
} from '../../src/sandbox-control/physical-lifecycle.js';
import type { ProviderAdapter, ProviderCreateIntent } from '../../src/sandbox-control/provider.js';
import {
  applyReportedSessionState,
  attachRoute,
} from '../../src/sandbox-control/session-routes.js';
import { SESSION_DELIVERY_TIMEOUT_MS } from '../../src/sandbox-session/control-dispatch.js';
import {
  createVercelProviderAdapter,
  encodeVercelProviderRef,
  type VercelControlRestClient,
} from '../../src/sandbox-control/vercel-provider.js';
import {
  createSessionMessageRecord,
  type SessionMessageRecord,
} from '../../src/sandbox-session/session-message-queue.js';
import { getPreparationSnapshots } from '../../src/session/preparation-history.js';
import { createEventQueries } from '../../src/session/queries/index.js';
import { throwAdmissionError } from '../../src/session/queue-message.js';
import {
  requestFrameSchema,
  sessionPromptPayloadSchema,
  SANDBOX_CONTROL_AUTO_PING,
  SANDBOX_CONTROL_AUTO_PONG,
  type RequestFrame,
  type ResponseFrame,
  type SessionAttachPayload,
} from '../../src/shared/sandbox-control-protocol.js';

vi.mock('../../src/session-access.js', () => ({
  requireCurrentSessionAccess: vi.fn(),
}));

vi.mock('../../src/db/pg.js', () => ({
  getPgDb: () => {
    throw new Error('PostgreSQL is not used by sandbox control integration tests');
  },
}));

const sandboxId = 'sbx__control_smoke';
const ROOT_ID = 'ses_abcdefghijklmnopqrstuvwxyz';
const SECOND_ROOT_ID = 'ses_zyxwvutsrqponmlkjihgfedcba';
const THIRD_ROOT_ID = 'ses_01234567890123456789012345';
const GRANT_SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const SECOND_GRANT_SESSION_ID = 'workspace_22222222-2222-4222-8222-222222222222';
const WORKTREE_ID: `worktree_${string}` = 'worktree_11111111-1111-4111-8111-111111111111';
const OTHER_WORKTREE_ID: `worktree_${string}` = 'worktree_22222222-2222-4222-8222-222222222222';
type ProviderCreateResult = Awaited<ReturnType<ProviderAdapter['create']>>;
const KILO_TOKEN = 'fixture-real-kilo-token';
const GITHUB_TOKEN = 'fixture-real-github-token';
const HOUR = 60 * 60 * 1000;
const INITIAL_MESSAGE_ID = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';

function cloudflareRef(id: string, instanceId = 'inst_1'): string {
  return encodeCloudflareProviderRef({ sandboxId: id, containment: true, instanceId });
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
  input: AttachSessionInput = {
    sessionId: GRANT_SESSION_ID,
    kiloSessionId: ROOT_ID,
    directory: '/workspace/contained',
    ownerId: CONTAINMENT_OWNER,
  },
  provider: AgentSandboxProvider = 'cloudflare'
): Promise<SessionCredentialGrant> {
  const now = Date.now();
  const grant = sessionCredentialGrantSchema.parse({
    version: 1,
    scopeId: input.worktreeId ?? input.sessionId,
    sandboxId: instance.sandboxId,
    directory: input.directory,
    userId: input.ownerId,
    provider,
    ...(provider === 'cloudflare'
      ? { outboundContainerId: `contained:${instance.sandboxId}` }
      : {}),
    members: [{ sessionId: input.sessionId, kiloSessionId: input.kiloSessionId }],
    kilo: {
      alias: createControlPlaneCredential(instance.sandboxId, 'kilo'),
      token: KILO_TOKEN,
      targets: CONTAINMENT_TARGETS,
      capabilities: {},
    },
    preparedAt: now,
    expiresAt: now + 4 * HOUR,
  });
  await state.storage.transaction(async () => {
    await saveSessionCredentialGrants(state.storage, [
      ...(await loadSessionCredentialGrants(state.storage)).filter(
        value => !value.members.some(member => member.sessionId === input.sessionId)
      ),
      grant,
    ]);
  });
  return grant;
}

async function attachGrantedSession(
  instance: SandboxControl,
  state: DurableObjectState,
  input: AttachSessionInput
) {
  await seedGrant(instance, state, input);
  return instance.attachSession(input);
}

async function seedCredential(credential: string, id = sandboxId): Promise<void> {
  const stub = env.SANDBOX_CONTROL.getByName(id);
  await runInDurableObject(stub, async instance => {
    if ((await instance.getPhysicalRecord()).state === 'stopped') {
      await instance.claimCreate('inst_1', false, id, WORKTREE_CREDENTIAL_CONTAINMENT);
    }
    await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
  });
}

async function seedRunningCredential(credential: string, id = sandboxId): Promise<void> {
  await seedCredential(credential, id);
  await runInDurableObject(env.SANDBOX_CONTROL.getByName(id), seedRunningCloudflare);
}

const socketSandboxIds = new WeakMap<WebSocket, string>();

async function connect(credential: string, id = sandboxId): Promise<WebSocket> {
  const response = await SELF.fetch(`http://worker.test/sandbox-control/${id}`, {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${credential}`,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Unexpected sandbox control upgrade: ${response.status}`);
  }
  response.webSocket.accept();
  socketSandboxIds.set(response.webSocket, id);
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

function nextMessages(ws: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const onMessage = (event: MessageEvent) => {
      messages.push(typeof event.data === 'string' ? event.data : String(event.data));
      if (messages.length !== count) return;
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      resolve(messages);
    };
    const onError = () => {
      ws.removeEventListener('message', onMessage);
      reject(new Error('sandbox control websocket error'));
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError, { once: true });
  });
}

type SessionStreamEvent = {
  eventId: number;
  sessionId: string;
  streamEventType: string;
  data: Record<string, unknown>;
};

async function connectSessionStream(
  sessionId: string,
  userId: string,
  eventTypes: string[]
): Promise<WebSocket> {
  const url = new URL('http://worker.test/stream');
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('userId', userId);
  url.searchParams.set('eventTypes', eventTypes.join(','));
  url.searchParams.set('replay', 'false');
  const response = await SELF.fetch(url.toString(), { headers: { Upgrade: 'websocket' } });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Unexpected session stream upgrade: ${response.status}`);
  }
  response.webSocket.accept();
  expect(JSON.parse(await nextMessage(response.webSocket))).toMatchObject({
    sessionId,
    streamEventType: 'connected',
  });
  return response.webSocket;
}

function persistedSessionEvents(state: DurableObjectState, eventTypes: string[]) {
  return createEventQueries(
    drizzle(state.storage, { logger: false }),
    state.storage.sql
  ).findByFilters({ eventTypes });
}

function sendHello(
  ws: WebSocket,
  requestId: string,
  identity: { providerInstanceId?: string; wrapperInstanceId?: string } = {}
): void {
  ws.send(
    JSON.stringify({
      type: 'request',
      requestId,
      operation: 'sandbox.hello',
      payload: {
        protocolVersion: 1,
        providerInstanceId:
          identity.providerInstanceId ?? cloudflareRef(socketSandboxIds.get(ws) ?? sandboxId),
        ...(identity.wrapperInstanceId ? { wrapperInstanceId: identity.wrapperInstanceId } : {}),
      },
    })
  );
}

async function completeHello(
  ws: WebSocket,
  requestId: string,
  identity: { providerInstanceId?: string; wrapperInstanceId?: string } = {}
): Promise<void> {
  sendHello(ws, requestId, identity);
  await expect(nextMessage(ws)).resolves.toBe(
    JSON.stringify({
      type: 'response',
      requestId,
      ok: true,
      result: { protocolVersion: 1, handshakeComplete: true },
    })
  );
  const status = JSON.parse(await nextMessage(ws)) as {
    type: string;
    requestId: string;
    operation: string;
  };
  expect(status).toMatchObject({ type: 'request', operation: 'sandbox.status' });
  ws.send(
    JSON.stringify({
      type: 'response',
      requestId: status.requestId,
      ok: true,
    })
  );
}

type TerminalRuntimeFixture = {
  sandboxId: `usr-${string}` | `ses-${string}`;
  sandboxProvider?: 'cloudflare' | 'vercel';
  ownerId: string;
  sessionId: `workspace_${string}`;
  wrapperInstanceId?: string;
};

async function initializeTerminalRuntime(fixture: TerminalRuntimeFixture) {
  const credential = generateSandboxCredential();
  await seedCredential(credential, fixture.sandboxId);
  const control = env.SANDBOX_CONTROL.getByName(fixture.sandboxId);
  const sandboxProvider = fixture.sandboxProvider ?? 'cloudflare';
  const providerRef =
    sandboxProvider === 'vercel'
      ? encodeVercelProviderRef({ sandboxName: fixture.sandboxId, sessionId: 'vercel_terminal' })
      : cloudflareRef(fixture.sandboxId);
  const provider = await installProvider(control, providerRef, sandboxProvider);
  await runInDurableObject(control, async (instance, state) => {
    Object.assign(instance, { providerKind: sandboxProvider });
    await state.storage.put('provider_kind', sandboxProvider);
    await instance.initializeOwner(fixture.ownerId);
    await instance.confirmInstance(providerRef);
    const attachment = {
      sessionId: fixture.sessionId,
      kiloSessionId: ROOT_ID,
      directory: '/workspace/terminal',
      ownerId: fixture.ownerId,
    };
    await seedGrant(instance, state, attachment, sandboxProvider);
    await instance.attachSession(attachment);
  });
  const socket = await connect(credential, fixture.sandboxId);
  await completeHello(socket, `hello_${fixture.sandboxId}`, {
    providerInstanceId: providerRef,
    ...(fixture.wrapperInstanceId ? { wrapperInstanceId: fixture.wrapperInstanceId } : {}),
  });
  return { control, credential, socket, providerRef, ...provider };
}

function signalWrapperReady(socket: WebSocket): void {
  socket.send(
    JSON.stringify({
      type: 'event',
      event: 'sandbox.ready',
      payload: { kiloReady: true, globalFeedAttached: true },
    })
  );
}

async function waitForWrapperReady(fixture: TerminalRuntimeFixture): Promise<void> {
  const control = env.SANDBOX_CONTROL.getByName(fixture.sandboxId);
  await vi.waitFor(async () => {
    const status = await runInDurableObject(control, instance => instance.getStatus());
    expect(status).toMatchObject({
      connection: 'ready',
      ...(fixture.wrapperInstanceId ? { wrapperInstanceId: fixture.wrapperInstanceId } : {}),
    });
  });
}

async function seedTerminalSession(fixture: TerminalRuntimeFixture, ptyId = 'pty_original') {
  if (!fixture.wrapperInstanceId) throw new Error('Terminal fixture requires wrapper identity');
  const session = env.SANDBOX_SESSION.getByName(`${fixture.ownerId}:${fixture.sessionId}`);
  await runInDurableObject(session, async (instance, state) => {
    await instance.registerSession({
      identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
      auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
      agent: {},
      workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
    });
    const attachment = {
      ownerId: fixture.ownerId,
      sessionId: fixture.sessionId,
      kiloSessionId: ROOT_ID,
      directory: '/workspace/terminal',
      sandboxId: fixture.sandboxId,
      wrapperInstanceId: fixture.wrapperInstanceId,
    };
    state.storage.kv.put('terminal_attached_session', attachment);
    state.storage.kv.put(`terminal:${ptyId}`, { ...attachment, ptyId, state: 'running' });
  });
  return session;
}

function acceptControlRequest(socket: WebSocket, request: RequestFrame): void {
  let result: unknown;
  switch (request.operation) {
    case 'session.attach':
      result = { attached: true };
      break;
    case 'session.prompt':
      result = {
        messageId: sessionPromptPayloadSchema.parse(request.payload).messageId,
        status: 'accepted',
      };
      break;
    case 'session.abort':
      result = { status: 'aborted' };
      break;
    case 'session.detach':
      result = { detached: true };
      break;
    case 'session.sync':
      result = { status: { type: 'busy' }, questions: [], permissions: [] };
      break;
    default:
      throw new Error(`Unexpected control request: ${request.operation}`);
  }
  socket.send(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true, result }));
}

function captureAndAcceptControlRequests(
  socket: WebSocket,
  hold?: (request: RequestFrame) => boolean
): RequestFrame[] {
  const requests: RequestFrame[] = [];
  socket.addEventListener('message', event => {
    const request = requestFrameSchema.parse(JSON.parse(String(event.data)));
    requests.push(request);
    if (!hold?.(request)) acceptControlRequest(socket, request);
  });
  return requests;
}

async function installProvider(
  control: ReturnType<typeof env.SANDBOX_CONTROL.getByName>,
  initialRef?: string,
  sandboxProvider: AgentSandboxProvider = 'cloudflare'
) {
  const allocations = new Set(initialRef ? [initialRef] : []);
  const allocationRef = (sandboxName: string, instanceId: string) =>
    sandboxProvider === 'vercel'
      ? encodeVercelProviderRef({ sandboxName, sessionId: `vercel_${instanceId}` })
      : cloudflareRef(sandboxName, instanceId);
  const provider = {
    resumable: false,
    ensureBillingAdmission: vi.fn<ProviderAdapter['ensureBillingAdmission']>(async () => undefined),
    create: vi.fn<ProviderAdapter['create']>(async intent => {
      if (!intent.allocationName) throw new Error('Expected a persisted allocation name');
      const providerRef = allocationRef(intent.allocationName, intent.intentId);
      allocations.add(providerRef);
      return { providerRef };
    }),
    launch: vi.fn<ProviderAdapter['launch']>(async () => undefined),
    observe: vi.fn<ProviderAdapter['observe']>(async (ref, intent) => {
      const providerRef =
        ref ??
        (intent?.allocationName
          ? allocationRef(intent.allocationName, intent.intentId)
          : undefined);
      return {
        status: providerRef && allocations.has(providerRef) ? 'active' : 'terminal',
        ...(providerRef ? { providerRef } : {}),
      };
    }),
    stop: vi.fn<ProviderAdapter['stop']>(async ref => {
      if (ref) allocations.delete(ref);
      return 'terminal';
    }),
    ensureLeaseAtLeast: vi.fn<ProviderAdapter['ensureLeaseAtLeast']>(async () => undefined),
    logs: vi.fn<ProviderAdapter['logs']>(async () => ''),
    updateNetworkPolicy: vi.fn<NonNullable<ProviderAdapter['updateNetworkPolicy']>>(
      async () => undefined
    ),
  } satisfies ProviderAdapter;
  await runInDurableObject(control, instance => {
    const prototype = Object.getPrototypeOf(instance) as {
      createProviderAdapter: () => ProviderAdapter;
    };
    const environment = {
      ...env,
      VERCEL_TOKEN: 'test-token',
      VERCEL_TEAM_ID: 'test-team',
      VERCEL_PROJECT_ID: 'test-project',
      VERCEL_SANDBOX_SNAPSHOT_ID: 'test-snapshot',
      VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'test-build',
      VERCEL_SANDBOX_RUNTIME: 'node24',
      VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
      VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
      ...fakeCloudflareContainers(() => instance.getPhysicalRecord()).bindings,
      GIT_TOKEN_SERVICE: fakeCredentialBroker().binding,
      KILOCODE_BACKEND_BASE_URL: CONTAINMENT_TARGETS.backendBaseUrl,
      KILO_OPENROUTER_BASE: CONTAINMENT_TARGETS.providerBaseUrl,
      KILO_SESSION_INGEST_URL: CONTAINMENT_TARGETS.sessionIngestBaseUrl,
    };
    vi.spyOn(prototype, 'createProviderAdapter').mockImplementation(
      function (this: SandboxControl) {
        Object.assign(this, { env: environment });
        return provider;
      }
    );
    Object.assign(instance, { provider, env: environment });
  });
  return { provider, allocations };
}

async function fireControlDeadline(
  control: ReturnType<typeof env.SANDBOX_CONTROL.getByName>,
  id: DeadlineId
): Promise<void> {
  await runInDurableObject(control, async (_instance, state) => {
    const deadlines = await loadDeadlines(state.storage);
    expect(deadlines[id]).toEqual(expect.any(Number));
    await saveDeadlines(state.storage, { ...deadlines, [id]: Date.now() });
  });
  await expect(runDurableObjectAlarm(control)).resolves.toBe(true);
}

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

async function rejectHello(
  ws: WebSocket,
  requestId: string,
  providerInstanceId: string
): Promise<void> {
  const response = nextMessage(ws);
  const closed = new Promise<number>(resolve => {
    ws.addEventListener('close', event => resolve(event.code), { once: true });
  });
  ws.send(
    JSON.stringify({
      type: 'request',
      requestId,
      operation: 'sandbox.hello',
      payload: { protocolVersion: 1, providerInstanceId },
    })
  );
  await expect(response).resolves.toBe(
    JSON.stringify({
      type: 'response',
      requestId,
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Invalid sandbox provider instance',
        retryable: false,
      },
    })
  );
  await expect(closed).resolves.toBe(1008);
}

const CONTAINMENT_OWNER = 'github|oauth:user/123';
const CONTAINMENT_REQUIREMENTS = WORKTREE_CREDENTIAL_CONTAINMENT;
const CONTAINMENT_TARGETS = {
  backendBaseUrl: 'https://api.kilo.ai',
  providerBaseUrl: 'https://provider.kilo.ai',
  sessionIngestBaseUrl: 'https://ingest.kilo.ai',
};
const CONTAINMENT_POLICY: VercelSandboxNetworkPolicy = {
  mode: 'custom',
  allowedDomains: ['api.kilo.ai', '*'],
  injectionRules: [
    {
      domain: 'api.kilo.ai',
      headers: {
        authorization: 'Bearer managed-firewall-test-token',
        host: 'api.kilo.ai',
      },
      match: {
        headers: [
          {
            key: { exact: 'authorization' },
            value: { exact: 'Bearer harmless-kilo-placeholder' },
          },
        ],
      },
    },
  ],
};

function fakeProvider(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
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
    ...overrides,
  };
}

function unresolvableVercelProvider(sandboxName: string, nativeCalls: string[]): ProviderAdapter {
  const config = parseVercelSandboxRuntimeConfig(VERCEL_ENV);
  if (!config) throw new Error('Missing Vercel test configuration');
  const unexpected = async (): Promise<never> => {
    nativeCalls.push('native request');
    throw new Error('Invalid provider reference reached the native API');
  };
  return createVercelProviderAdapter({
    sandboxName,
    config,
    restClient: {
      createSandbox: unexpected,
      inspectByName: unexpected,
      getSession: unexpected,
      executeCommand: unexpected,
      extendSessionTimeout: unexpected,
      stopSession: unexpected,
      readFile: unexpected,
      updateNetworkPolicy: unexpected,
    },
  });
}

function containedRunningRecord(
  providerRef: string,
  containment: CredentialContainmentRequirements = CONTAINMENT_REQUIREMENTS
): PhysicalRecord {
  const cloudflare = decodeCloudflareProviderRef(providerRef);
  return confirmRunning(
    claimCreate(
      initialPhysicalRecord(false),
      cloudflare?.instanceId ?? 'intent_contained',
      Date.now() - DEADLINE_MS.createSettle - 1,
      cloudflare?.sandboxId,
      containment
    ),
    providerRef,
    1
  );
}

async function seedRunningVercel(
  instance: SandboxControl,
  state: DurableObjectState,
  requestedSandboxId: string,
  provider: ProviderAdapter,
  options?: {
    ownerId?: string;
    providerKind?: 'vercel' | 'cloudflare';
    physical?: PhysicalRecord;
    bypassPin?: boolean;
  }
): Promise<string> {
  const providerRef = encodeVercelProviderRef({
    sandboxName: requestedSandboxId,
    sessionId: 'vsess_contained',
  });
  await instance.initializeOwner(options?.ownerId ?? CONTAINMENT_OWNER);
  await state.storage.put('provider_kind', options?.providerKind ?? 'vercel');
  await state.storage.put(
    'physical_record',
    options?.physical ?? containedRunningRecord(providerRef)
  );
  Object.assign(instance, {
    provider,
    createProviderAdapter: () => provider,
    providerKind: options?.providerKind ?? 'vercel',
    ...(options?.bypassPin ? { pinProvider: async () => true } : {}),
  });
  return providerRef;
}

function policyUpdateInput(ownerId = CONTAINMENT_OWNER): {
  ownerId: string;
  networkPolicy: VercelSandboxNetworkPolicy;
  requiredContainment: CredentialContainmentRequirements;
} {
  return {
    ownerId,
    networkPolicy: CONTAINMENT_POLICY,
    requiredContainment: CONTAINMENT_REQUIREMENTS,
  };
}

type CredentialRegistration = Parameters<SandboxSession['registerSession']>[0];
type KiloSubject = Parameters<GitTokenService['issueKiloSessionCapability']>[0];
type GitHubSubject = Parameters<GitTokenService['issueGitHubSessionCapability']>[0];

const VERCEL_ENV = {
  VERCEL_TOKEN: 'fixture-vercel-token',
  VERCEL_TEAM_ID: 'team_test',
  VERCEL_PROJECT_ID: 'prj_test',
  VERCEL_SANDBOX_SNAPSHOT_ID: 'snap_test',
  VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build_test',
  VERCEL_SANDBOX_RUNTIME: 'node24',
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
  VERCEL_SANDBOX_EXTEND_DURATION_MS: '120000',
};

function fakeCredentialBroker() {
  const kiloSubjects = new Map<string, KiloSubject>();
  const githubSubjects = new Map<string, GitHubSubject>();
  const tokens = { github: GITHUB_TOKEN };
  let serial = 0;
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected raw credential lookup or capability redemption');
  };
  const binding: GitTokenService = {
    async getTokenForRepo() {
      return {
        success: true,
        token: tokens.github,
        installationId: '42',
        accountLogin: 'acme',
        appType: 'standard',
      };
    },
    getToken: unexpected,
    getCloudAgentAuthForRepo: unexpected,
    getGitLabToken: unexpected,
    issueGitLabSessionCapability: unexpected,
    redeemGitLabSessionCapability: unexpected,
    issueBitbucketSessionCapability: unexpected,
    redeemBitbucketSessionCapability: unexpected,
    redeemGitHubSessionCapability: unexpected,
    redeemKiloSessionCapability: unexpected,
    async issueKiloSessionCapability(subject) {
      const capability = `kka1.fixture-${++serial}`;
      kiloSubjects.set(capability, subject);
      return { success: true, capability };
    },
    async issueGitHubSessionCapability(subject) {
      const capability = `kgh2.fixture-${++serial}`;
      githubSubjects.set(capability, subject);
      return {
        success: true,
        capability,
        installationId: '42',
        accountLogin: 'acme',
        appType: 'standard',
        source: 'installation',
        gitAuthor: { name: 'fixture bot', email: 'fixture@example.com' },
      };
    },
  };
  return { binding, kiloSubjects, githubSubjects, tokens };
}

type WrapperLaunch = {
  env: Record<string, string>;
  physical: PhysicalRecord;
  containerId?: string;
  outboundHandler?: string;
  networkPolicy?: VercelSandboxNetworkPolicy;
};

function fakeCloudflareContainers(readPhysical: () => Promise<PhysicalRecord>) {
  const runtime = {
    launches: [] as WrapperLaunch[],
    destroyed: [] as string[],
    running: new Set<string>(),
    handlers: new Map<string, string>(),
    failOutbound: false,
  };
  const namespace = (name: string) =>
    Object.assign({} as Env['Sandbox'], {
      idFromName: (id: string) => ({ toString: () => `${name}:${id}` }),
      getByName(id: string) {
        return this.get(this.idFromName(id) as DurableObjectId);
      },
      get: (id: DurableObjectId) => {
        const containerId = id.toString();
        return {
          async configure() {},
          async setOutboundHandler(handler: string) {
            if (runtime.failOutbound) throw new Error('Outbound handler unavailable');
            runtime.handlers.set(containerId, handler);
          },
          async startProcess(_command: string, options?: { env?: Record<string, string> }) {
            runtime.launches.push({
              env: options?.env ?? {},
              containerId,
              outboundHandler: runtime.handlers.get(containerId),
              physical: await readPhysical(),
            });
            runtime.running.add(containerId);
            return {};
          },
          async forceDestroyForControlPlane() {
            runtime.destroyed.push(containerId);
            runtime.running.delete(containerId);
          },
          async destroy() {
            throw new Error('Legacy SDK destruction must not be used');
          },
          async isContainerRunning() {
            return runtime.running.has(containerId);
          },
          async renewActivityTimeout() {},
        };
      },
    });
  return {
    ...runtime,
    bindings: {
      Sandbox: namespace('standard'),
      SandboxContainment: namespace('contained'),
      SandboxSmall: namespace('small'),
      SandboxSmallContainment: namespace('contained-small'),
      SandboxCodeReview: namespace('review'),
      SandboxCodeReviewContainment: namespace('contained-review'),
      SandboxDIND: namespace('dind'),
    },
    setOutboundFailure: () => {
      runtime.failOutbound = true;
    },
  };
}

function fakeVercelRuntime(sandboxName: string, readPhysical: () => Promise<PhysicalRecord>) {
  const runtime = {
    creates: 0,
    launches: [] as WrapperLaunch[],
    policy: undefined as VercelSandboxNetworkPolicy | undefined,
    stoppedSessions: [] as string[],
    failPolicy: false,
    failStop: false,
    beforeLaunch: undefined as (() => Promise<void>) | undefined,
    beforePolicyUpdate: undefined as
      | ((policy: VercelSandboxNetworkPolicy) => Promise<void>)
      | undefined,
  };
  let session: VercelSandboxSession = {
    id: 'vsess_joined_0',
    sourceSandboxName: sandboxName,
    projectId: VERCEL_ENV.VERCEL_PROJECT_ID,
    runtime: 'node24',
    status: 'running',
    memory: 2048,
    vcpus: 2,
    region: 'iad1',
    timeout: 300_000,
    requestedAt: Date.now(),
    startedAt: Date.now(),
    cwd: '/',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const client: VercelControlRestClient = {
    async inspectByName(input) {
      if (runtime.creates === 0 || input.name !== session.sourceSandboxName) return null;
      return {
        sandbox: {
          name: sandboxName,
          currentSessionId: session.id,
          status: session.status === 'running' ? 'running' : 'stopped',
          persistent: false,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          tags: {},
        },
        session,
        routes: [],
        runtime: { sandboxName, sessionId: session.id },
      };
    },
    async createSandbox(input) {
      sandboxName = input.name;
      runtime.creates += 1;
      runtime.policy = input.networkPolicy;
      session = {
        ...session,
        sourceSandboxName: sandboxName,
        id: `vsess_joined_${runtime.creates}`,
        status: 'running',
      };
      return {
        sandbox: {
          name: sandboxName,
          currentSessionId: session.id,
          status: 'running',
          persistent: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tags: {},
        },
        session,
        routes: [],
        runtime: { sandboxName, sessionId: session.id },
      };
    },
    async executeCommand(sessionId, input) {
      await runtime.beforeLaunch?.();
      runtime.launches.push({
        env: input.env ?? {},
        physical: await readPhysical(),
        networkPolicy: runtime.policy,
      });
      return {
        id: 'cmd_joined',
        name: input.command,
        args: input.args ?? [],
        cwd: '/',
        sessionId,
        exitCode: null,
        startedAt: Date.now(),
      };
    },
    async updateNetworkPolicy(_sessionId, _sandboxName, policy) {
      if (runtime.failPolicy) throw new Error('Native policy update unavailable');
      await runtime.beforePolicyUpdate?.(policy);
      runtime.policy = policy;
      return session;
    },
    async getSession() {
      return { session, routes: [] };
    },
    async extendSessionTimeout() {
      return session;
    },
    async stopSession(sessionId) {
      if (sessionId !== session.id) throw new Error('Unexpected native session stop');
      if (runtime.failStop) throw new Error('Native stop temporarily unavailable');
      runtime.stoppedSessions.push(sessionId);
      session = { ...session, status: 'stopped' };
      return session;
    },
    async readFile() {
      return new Uint8Array();
    },
  };
  const config = parseVercelSandboxRuntimeConfig(VERCEL_ENV);
  if (!config) throw new Error('Invalid Vercel test configuration');
  return {
    runtime,
    get provider() {
      return createVercelProviderAdapter({ sandboxName, config, restClient: client });
    },
    createAdapter: (allocationName: string) =>
      createVercelProviderAdapter({ sandboxName: allocationName, config, restClient: client }),
  };
}

async function registerCredentialSession(registration: CredentialRegistration) {
  const session = env.SANDBOX_SESSION.getByName(
    `${registration.identity.userId}:${registration.identity.sessionId}`
  );
  await expect(session.registerSession(registration)).resolves.toEqual({ success: true });
  return session;
}

async function credentialFixture(
  provider: AgentSandboxProvider = 'cloudflare',
  id: SandboxId = `${provider === 'vercel' ? 'ses' : 'usr'}-${crypto.randomUUID().replaceAll('-', '')}`
) {
  const control = env.SANDBOX_CONTROL.getByName(id);
  const broker = fakeCredentialBroker();
  const environment = {
    ...env,
    ...VERCEL_ENV,
    GIT_TOKEN_SERVICE: broker.binding,
    WORKER_URL: 'https://worker.test',
    KILOCODE_BACKEND_BASE_URL: CONTAINMENT_TARGETS.backendBaseUrl,
    KILO_OPENROUTER_BASE: CONTAINMENT_TARGETS.providerBaseUrl,
    KILO_SESSION_INGEST_URL: CONTAINMENT_TARGETS.sessionIngestBaseUrl,
  };
  let containers: ReturnType<typeof fakeCloudflareContainers> | undefined;
  let vercel: ReturnType<typeof fakeVercelRuntime> | undefined;
  await runInDurableObject(control, instance => {
    containers = fakeCloudflareContainers(() => instance.getPhysicalRecord());
    vercel = fakeVercelRuntime(id, () => instance.getPhysicalRecord());
    Object.assign(environment, containers.bindings);
    Object.assign(instance, { env: environment });
    if (provider === 'vercel') {
      const runtime = vercel;
      Object.assign(instance, {
        createProviderAdapter: (_kind: AgentSandboxProvider, physical?: PhysicalRecord) =>
          runtime.createAdapter(physical?.createIntent?.allocationName ?? id),
      });
    }
  });
  if (!containers || !vercel) throw new Error('Missing credential fixture');
  const registration: CredentialRegistration = {
    identity: {
      sessionId: `workspace_${crypto.randomUUID()}`,
      userId: CONTAINMENT_OWNER,
      orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
    agent: { mode: 'code', model: 'test' },
    repository: {
      type: 'github',
      repo: 'acme/repo',
      githubIntegrationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
    workspace: {
      sandboxId: id,
      sandboxProvider: provider,
      worktreeId: WORKTREE_ID,
      workspacePath: '/workspace/joined',
    },
    profile: {
      envVars: {
        KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: KILO_TOKEN } }),
        PUBLIC_VALUE: 'preserved',
      },
      setupCommands: [`fixture-command --credential=${KILO_TOKEN}`],
    },
  };
  const session = await registerCredentialSession(registration);
  const nativeContainers = containers;
  return {
    control,
    broker,
    containers,
    vercel,
    registration,
    session,
    environment,
    sandboxId: id,
    get outboundContainerId() {
      if (provider === 'vercel') return '';
      const value = nativeContainers.launches.at(-1)?.containerId;
      if (!value) throw new Error('Missing native container identity');
      return value;
    },
  };
}

async function credentialTerminalFixture(provider: AgentSandboxProvider) {
  const fixture = await credentialFixture(provider);
  const status = await fixture.control.ensureReady({
    ...credentialInput(fixture.registration),
    provider,
    allowCreate: true,
  });
  const payload = status.attachment;
  const launch =
    provider === 'vercel' ? fixture.vercel.runtime.launches[0] : fixture.containers.launches[0];
  if (!payload || !launch) throw new Error('Missing contained terminal runtime');
  await fixture.control.attachSession(attachInput(fixture.registration, payload));
  const wrapperInstanceId = crypto.randomUUID();
  const socket = await connect(launch.env.SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
  await completeHello(socket, 'hello-credential-terminal', {
    providerInstanceId: launch.env.PROVIDER_INSTANCE_ID,
    wrapperInstanceId,
  });
  signalWrapperReady(socket);
  await vi.waitFor(async () => {
    await expect(fixture.control.getStatus()).resolves.toMatchObject({
      connection: 'ready',
      wrapperInstanceId,
    });
  });
  return {
    ...fixture,
    socket,
    access: {
      ...credentialInput(fixture.registration),
      wrapperInstanceId,
      ...(fixture.registration.identity.orgId
        ? { organizationId: fixture.registration.identity.orgId }
        : {}),
    },
  };
}

async function registerSiblingWorktree(registration: CredentialRegistration) {
  const sibling: CredentialRegistration = {
    ...registration,
    identity: { ...registration.identity, sessionId: `workspace_${crypto.randomUUID()}` },
    auth: { ...registration.auth, kiloSessionId: SECOND_ROOT_ID },
    workspace: {
      ...registration.workspace,
      worktreeId: OTHER_WORKTREE_ID,
      workspacePath: '/workspace/other',
    },
  };
  await registerCredentialSession(sibling);
  return sibling;
}

async function credentialExpiryDeadline(control: DurableObjectStub<SandboxControl>) {
  return runInDurableObject(control, async (_instance, state) => {
    const deadlines = await state.storage.get<{ credentialExpiry?: number }>('deadlines');
    return deadlines?.credentialExpiry;
  });
}

async function runCredentialExpiryAlarm(control: DurableObjectStub<SandboxControl>) {
  await runInDurableObject(control, async (instance, state) => {
    const deadlines = await state.storage.get<{ credentialExpiry?: number }>('deadlines');
    await state.storage.put('deadlines', {
      ...(deadlines?.credentialExpiry !== undefined
        ? { credentialExpiry: deadlines.credentialExpiry }
        : {}),
    });
    await instance.alarm();
  });
}

async function finishFailedCreation(control: DurableObjectStub<SandboxControl>): Promise<void> {
  const physical = await control.getPhysicalRecord();
  if (!physical.createIntent) throw new Error('Missing retained creation intent');
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(physical.createIntent.createdAt + DEADLINE_MS.createSettle + 1);
  try {
    await control.recordStopAttempt();
  } finally {
    clock.mockRestore();
  }
  await expect(control.getPhysicalRecord()).resolves.toMatchObject({
    state: 'stopped',
    providerRef: null,
  });
}

async function readyAttachment(
  control: DurableObjectStub<SandboxControl>,
  input: { ownerId: string; sessionId: string }
): Promise<SessionAttachPayload> {
  const session = env.SANDBOX_SESSION.getByName(`${input.ownerId}:${input.sessionId}`);
  const metadata = await runInDurableObject(session, instance => instance.getCredentialMetadata());
  const status = await control.ensureReady({
    ...input,
    provider: metadata?.workspace?.sandboxProvider ?? 'cloudflare',
    allowCreate: true,
  });
  if (!status.attachment) throw new Error('Missing contained readiness attachment');
  return status.attachment;
}

function credentialInput(registration: CredentialRegistration) {
  return { ownerId: registration.identity.userId, sessionId: registration.identity.sessionId };
}

function attachInput(registration: CredentialRegistration, payload: SessionAttachPayload) {
  if (!payload.directory || !registration.auth.kiloSessionId) {
    throw new Error('Missing prepared session identity');
  }
  return {
    ...credentialInput(registration),
    kiloSessionId: registration.auth.kiloSessionId,
    directory: payload.directory,
    ...(registration.workspace?.worktreeId
      ? { worktreeId: registration.workspace.worktreeId }
      : {}),
  };
}

async function storedGrants(control: DurableObjectStub<SandboxControl>) {
  return runInDurableObject(control, (_instance, state) =>
    loadSessionCredentialGrants(state.storage)
  );
}

async function updateCredentialMetadata(
  session: DurableObjectStub<SandboxSession>,
  update: (metadata: SessionMetadata) => SessionMetadata
) {
  await runInDurableObject(session, async (instance, state) => {
    const metadata = await instance.getCredentialMetadata();
    if (!metadata) throw new Error('Missing registered credential metadata');
    state.storage.kv.put(SANDBOX_SESSION_METADATA_KEY, serializeSessionMetadata(update(metadata)));
  });
}

function expectSanitized(value: unknown, broker: ReturnType<typeof fakeCredentialBroker>) {
  const serialized = JSON.stringify(value);
  for (const secret of [
    KILO_TOKEN,
    GITHUB_TOKEN,
    broker.tokens.github,
    ...broker.kiloSubjects.keys(),
    ...broker.githubSubjects.keys(),
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

function expectCredentialFreeLaunch(
  launch: WrapperLaunch,
  broker: ReturnType<typeof fakeCredentialBroker>
) {
  for (const key of [
    'KILOCODE_TOKEN',
    'KILO_AUTH_CONTENT',
    'KILO_CONFIG_CONTENT',
    'OPENCODE_CONFIG_CONTENT',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
    'BITBUCKET_TOKEN',
  ]) {
    expect(launch.env).not.toHaveProperty(key);
  }
  expectSanitized(launch.env, broker);
}

function policyAuthorization(
  policy: VercelSandboxNetworkPolicy | undefined,
  credential: string,
  url: string,
  method = 'GET'
) {
  return findMatchingCredentialInjectionRule(policy?.injectionRules ?? [], {
    url: new URL(url),
    method,
    headers: new Headers({ authorization: `Bearer ${credential}` }),
  })?.headers.authorization;
}

type SandboxControlStub = ReturnType<(typeof env.SANDBOX_CONTROL)['getByName']>;

type WrapperRequest = {
  type: string;
  requestId: string;
  operation: string;
  session?: { sessionId: string; kiloSessionId: string; directory: string };
  payload?: Record<string, unknown>;
};

async function deliverWrapperEvent(
  stub: SandboxControlStub,
  event: string,
  payload: unknown,
  session?: { directory: string; kiloSessionId?: string; rootKiloSessionId?: string }
): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    const socket = state.getWebSockets('sandbox-control')[0];
    if (!socket) throw new Error('Expected sandbox-control socket');
    await instance.webSocketMessage(
      socket,
      JSON.stringify({
        type: 'event',
        event,
        payload,
        ...(session ? { session } : {}),
      })
    );
  });
}

function respondToWrapperRequest(ws: WebSocket, request: WrapperRequest, result: unknown): void {
  ws.send(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true, result }));
}

function groupedRoute(sessionId: string, kiloSessionId: string, ownerId = 'owner_1') {
  return {
    sessionId,
    kiloSessionId,
    directory: '/workspace/shared',
    ownerId,
    worktreeId: WORKTREE_ID,
  };
}

function groupedRegistration(input: {
  ownerId: `user_${string}`;
  sessionId: `workspace_${string}`;
  kiloSessionId: string;
  sandboxId: `usr-${string}` | `ses-${string}`;
  provider?: 'cloudflare' | 'vercel';
}) {
  const repository = {
    type: 'github' as const,
    repo: 'Kilo-Org/cloud',
    branch: 'feature/shared-worktree',
  };
  return {
    identity: { sessionId: input.sessionId, userId: input.ownerId },
    auth: { kiloSessionId: input.kiloSessionId, kilocodeToken: KILO_TOKEN },
    agent: { mode: 'code', model: 'test-model' },
    repository,
    workspace: {
      sandboxId: input.sandboxId,
      sandboxProvider: input.provider ?? 'cloudflare',
      workspacePath: '/workspace/shared',
      worktreeId: WORKTREE_ID,
    },
    finalization: { autoCommit: true, condenseOnComplete: true },
  };
}

describe('SandboxControl in the Workers runtime', () => {
  it('rejects a missing credential', async () => {
    const response = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(response.status).toBe(401);
  });

  it('rejects a wrong credential', async () => {
    await seedCredential(generateSandboxCredential());
    const response = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${generateSandboxCredential()}`,
      },
    });
    expect(response.status).toBe(401);
  });

  it('accepts an authenticated hello but quarantines the runtime when its socket is replaced', async () => {
    const id = 'sbx_control_replaced';
    const credential = generateSandboxCredential();
    await seedRunningCredential(credential, id);
    const control = env.SANDBOX_CONTROL.getByName(id);
    const { provider } = await installProvider(control, cloudflareRef(id));
    provider.stop.mockResolvedValue('retryable');
    const first = await connect(credential, id);
    await completeHello(first, 'hello-1');
    await expect(control.getStatus()).resolves.toMatchObject({ connection: 'connected' });

    const firstClosed = new Promise<number>(resolve => {
      first.addEventListener('close', event => resolve(event.code), { once: true });
    });
    const second = await connect(credential, id);
    const secondClosed = new Promise<number>(resolve => {
      second.addEventListener('close', event => resolve(event.code), { once: true });
    });
    sendHello(second, 'hello-2');
    await expect(firstClosed).resolves.toBe(4000);
    await expect(secondClosed).resolves.toBe(4001);
    await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
    await expect(control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopping',
      providerRef: cloudflareRef(id),
      stopTombstone: { reason: 'control_replaced', attempts: 1 },
    });
    await runInDurableObject(control, async instance => {
      await expect(instance.request({ operation: 'sandbox.status', payload: {} })).rejects.toThrow(
        'not ready'
      );
    });
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('closes duplicate provisional sockets after a successful handshake', async () => {
    const id = 'sbx__control_provisional_duplicates';
    const credential = generateSandboxCredential();
    await seedCredential(credential, id);
    const stub = env.SANDBOX_CONTROL.getByName(id);
    await runInDurableObject(stub, async instance => {
      await seedRunningCloudflare(instance);
    });

    const provisional = await connect(credential, id);
    const successful = await connect(credential, id);
    const provisionalClosed = new Promise<number>(resolve => {
      provisional.addEventListener('close', event => resolve(event.code), { once: true });
    });

    await completeHello(successful, 'hello-provisional-duplicates', {
      providerInstanceId: cloudflareRef(id),
    });
    await expect(provisionalClosed).resolves.toBe(1008);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.getStatus()).resolves.toMatchObject({
        physical: 'running',
        connection: 'connected',
      });
      expect((await loadDeadlines(state.storage)).socketHandshake).toBeUndefined();
    });

    successful.close();
  });

  it('closes the live socket when the credential hash rotates', async () => {
    const sandboxId = 'sbx_control_rotate';
    const firstCredential = generateSandboxCredential();
    await seedRunningCredential(firstCredential, sandboxId);
    const first = await connect(firstCredential, sandboxId);
    await completeHello(first, 'hello-rotate');

    const firstClosed = new Promise<number>(resolve => {
      first.addEventListener('close', event => resolve(event.code), { once: true });
    });
    const nextCredential = generateSandboxCredential();
    await seedCredential(nextCredential, sandboxId);
    await expect(firstClosed).resolves.toBe(4001);

    const rejected = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${firstCredential}`,
      },
    });
    expect(rejected.status).toBe(401);

    const replacement = await connect(nextCredential, sandboxId);
    await completeHello(replacement, 'hello-rotated');
    replacement.close();
  });

  it('correlates an outbound request with the wrapper response', async () => {
    const sandboxId = 'sbx_control_rpc';
    const credential = generateSandboxCredential();
    await seedRunningCredential(credential, sandboxId);
    const ws = await connect(credential, sandboxId);
    await completeHello(ws, 'hello-rpc');

    const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
    signalWrapperReady(ws);
    await vi.waitFor(async () => {
      await expect(stub.getStatus()).resolves.toMatchObject({ connection: 'ready' });
    });
    const inbound = nextMessage(ws);
    const pending = runInDurableObject(stub, instance =>
      instance.request({ operation: 'sandbox.status', payload: {} })
    );
    const request = JSON.parse(await inbound) as {
      type: string;
      requestId: string;
      operation: string;
    };
    expect(request).toMatchObject({ type: 'request', operation: 'sandbox.status' });
    ws.send(
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok: true,
        result: { healthy: true, state: 'idle', version: 'test' },
      })
    );
    await expect(pending).resolves.toMatchObject({
      type: 'response',
      requestId: request.requestId,
      ok: true,
    });
    ws.close();
  });
});

describe('SandboxControl auto-response ping', () => {
  it('registers a ping/pong pair that does not require a DO invocation', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_auto_ping');
    await runInDurableObject(stub, async (_instance, state) => {
      const pair = state.getWebSocketAutoResponse();
      expect(pair?.request).toBe(SANDBOX_CONTROL_AUTO_PING);
      expect(pair?.response).toBe(SANDBOX_CONTROL_AUTO_PONG);
    });
  });
});

describe('SandboxControl owner identity', () => {
  it('returns null before initialize', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_owner_null');
    await runInDurableObject(stub, async instance => {
      await expect(instance.getOwner()).resolves.toBeNull();
    });
  });

  it('stores the owner on first initialize', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_owner_init');
    await runInDurableObject(stub, async instance => {
      await expect(instance.initializeOwner('user-1')).resolves.toEqual({ ownerId: 'user-1' });
      await expect(instance.getOwner()).resolves.toBe('user-1');
    });
  });

  it('is idempotent for the same owner', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_owner_idempotent');
    await runInDurableObject(stub, async instance => {
      await instance.initializeOwner('user-1');
      await expect(instance.initializeOwner('user-1')).resolves.toEqual({ ownerId: 'user-1' });
      await expect(instance.initializeOwner('  user-1  ')).resolves.toEqual({ ownerId: 'user-1' });
      await expect(instance.getOwner()).resolves.toBe('user-1');
    });
  });

  it('rejects a different owner and keeps the original', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_owner_mismatch');
    await runInDurableObject(stub, async instance => {
      await instance.initializeOwner('user-1');
      await expect(instance.initializeOwner('user-2')).rejects.toThrow('Sandbox owner mismatch');
      await expect(instance.getOwner()).resolves.toBe('user-1');
    });
  });

  it('rejects an empty ownerId', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_owner_empty');
    await runInDurableObject(stub, async instance => {
      await expect(instance.initializeOwner('')).rejects.toThrow(
        'ownerId must be a non-empty string'
      );
      await expect(instance.initializeOwner('   ')).rejects.toThrow(
        'ownerId must be a non-empty string'
      );
      await expect(instance.getOwner()).resolves.toBeNull();
    });
  });
});

describe('SandboxControl recovery watchdogs', () => {
  it('retains the original cleanup deadline when an unknown disconnected provider reports active', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_recovery_disconnected');
    await runInDurableObject(stub, async (instance, state) => {
      const providerRef = await seedRunningCloudflare(instance);
      const uncertain = await instance.observeProvider('unknown');
      expect(uncertain).toMatchObject({
        state: 'unknown',
        providerRef,
        stopTombstone: { reason: 'provider_unknown' },
      });
      const deadlines = await loadDeadlines(state.storage);
      expect(deadlines.wrapperReadiness).toBeUndefined();
      expect(deadlines.heartbeatExpiry).toBeUndefined();
      expect(deadlines.stopAttempt).toEqual(expect.any(Number));
      await expect(instance.observeProvider('active')).resolves.toEqual(uncertain);
      await instance.observeProvider('unknown');
      await expect(instance.observeProvider('active')).resolves.toEqual(uncertain);
      const after = await loadDeadlines(state.storage);
      expect(after).toEqual({ ...deadlines, reconciliation: expect.any(Number) });
      expect(after.reconciliation).toBeLessThanOrEqual(Date.now() + DEADLINE_MS.reconciliation);
      expect(await state.storage.getAlarm()).toBe(deadlines.stopAttempt);
    });
  });

  it('revokes heartbeat authority and rejects recovery of an unknown formerly ready provider', async () => {
    const id = 'sbx__control_recovery_ready';
    const credential = generateSandboxCredential();
    await seedCredential(credential, id);
    const stub = env.SANDBOX_CONTROL.getByName(id);
    await runInDurableObject(stub, async instance => {
      await seedRunningCloudflare(instance);
    });

    const ws = await connect(credential, id);
    await completeHello(ws, 'hello-recovery-ready', { providerInstanceId: cloudflareRef(id) });
    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'sandbox.ready',
        payload: { kiloReady: true, globalFeedAttached: true },
      })
    );
    await vi.waitFor(async () => {
      await runInDurableObject(stub, async instance => {
        await expect(instance.getStatus()).resolves.toMatchObject({ connection: 'ready' });
      });
    });

    await runInDurableObject(stub, async (instance, state) => {
      const initialDeadlines = await loadDeadlines(state.storage);
      expect(initialDeadlines.heartbeatExpiry).toEqual(expect.any(Number));
      delete initialDeadlines.heartbeatExpiry;
      await saveDeadlines(state.storage, initialDeadlines);
      await instance.observeProvider('unknown');

      const uncertain = await instance.getPhysicalRecord();
      await expect(instance.observeProvider('active')).resolves.toEqual(uncertain);
      expect(uncertain).toMatchObject({
        state: 'unknown',
        providerRef: cloudflareRef(id),
        stopTombstone: { reason: 'provider_unknown' },
      });
      const deadlines = await loadDeadlines(state.storage);
      expect(deadlines.heartbeatExpiry).toBeUndefined();
      expect(deadlines.wrapperReadiness).toBeUndefined();
      expect(deadlines.stopAttempt).toEqual(expect.any(Number));
      expect(await state.storage.getAlarm()).toBe(deadlines.stopAttempt);
      await expect(instance.getStatus()).resolves.toMatchObject({ connection: 'disconnected' });
      await instance.observeProvider('unknown');
      await instance.observeProvider('active');
      const after = await loadDeadlines(state.storage);
      expect(after).toEqual({ ...deadlines, reconciliation: expect.any(Number) });
      expect(after.reconciliation).toBeLessThanOrEqual(Date.now() + DEADLINE_MS.reconciliation);
    });

    ws.close();
  });
});

describe('SandboxControl Vercel network policy updates', () => {
  it('rejects an uninitialized owner without initializing ownership', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__policy_owner_missing');
    await runInDurableObject(stub, async instance => {
      await expect(instance.updateNetworkPolicy(policyUpdateInput())).rejects.toThrow(
        'Sandbox owner is not initialized'
      );
      await expect(instance.getOwner()).resolves.toBeNull();
    });
  });

  it('requires an exact existing OAuth owner before invoking the provider', async () => {
    const requestedSandboxId = 'sbx__policy_owner_mismatch';
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      let updates = 0;
      const provider = fakeProvider({
        async updateNetworkPolicy() {
          updates += 1;
        },
      });
      await seedRunningVercel(instance, state, requestedSandboxId, provider);
      await expect(
        instance.updateNetworkPolicy(policyUpdateInput(`${CONTAINMENT_OWNER} `))
      ).rejects.toThrow('Sandbox owner mismatch');
      expect(updates).toBe(0);
      await expect(instance.getOwner()).resolves.toBe(CONTAINMENT_OWNER);
    });
  });

  it('rejects a non-Vercel provider', async () => {
    const requestedSandboxId = 'sbx__policy_provider_kind';
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      await seedRunningVercel(instance, state, requestedSandboxId, fakeProvider(), {
        providerKind: 'cloudflare',
      });
      await expect(instance.updateNetworkPolicy(policyUpdateInput())).rejects.toThrow(
        'Sandbox network policy requires a Vercel provider'
      );
    });
  });

  it.each(['stopped', 'creating', 'stopping', 'failed', 'unknown'] as const)(
    'rejects a %s physical instance',
    async physicalState => {
      const requestedSandboxId = `sbx__policy_state_${physicalState}`;
      const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
      await runInDurableObject(stub, async (instance, state) => {
        const providerRef = encodeVercelProviderRef({
          sandboxName: requestedSandboxId,
          sessionId: 'vsess_not_running',
        });
        await seedRunningVercel(instance, state, requestedSandboxId, fakeProvider(), {
          physical: { ...containedRunningRecord(providerRef), state: physicalState },
        });
        await expect(instance.updateNetworkPolicy(policyUpdateInput())).rejects.toThrow(
          'Sandbox network policy requires a running instance'
        );
      });
    }
  );

  it.each([
    {
      name: 'missing',
      providerRef: null,
      error: 'Sandbox network policy requires a running instance',
    },
    {
      name: 'malformed',
      providerRef: 'logical-name-only',
      error: 'Sandbox network policy requires an exact provider reference',
    },
    {
      name: 'different-sandbox',
      providerRef: encodeVercelProviderRef({
        sandboxName: 'sbx__someone_else',
        sessionId: 'vsess_other',
      }),
      error: 'Sandbox network policy requires an exact provider reference',
    },
  ])('rejects a $name physical provider reference', async ({ name, providerRef, error }) => {
    const requestedSandboxId = `sbx__policy_ref_${name}`;
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      const physical: PhysicalRecord = {
        state: 'running',
        providerRef,
        createIntent: null,
        stopTombstone: null,
        resumable: false,
        ...(providerRef ? { containment: { ...CONTAINMENT_REQUIREMENTS, providerRef } } : {}),
      };
      await seedRunningVercel(instance, state, requestedSandboxId, fakeProvider(), { physical });
      await expect(instance.updateNetworkPolicy(policyUpdateInput())).rejects.toThrow(error);
    });
  });

  it.each(['missing', 'wrong-reference', 'wrong-flags', 'old-marker'] as const)(
    'rejects a %s containment marker',
    async markerKind => {
      const requestedSandboxId = `sbx__policy_marker_${markerKind}`;
      const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
      await runInDurableObject(stub, async (instance, state) => {
        const providerRef = encodeVercelProviderRef({
          sandboxName: requestedSandboxId,
          sessionId: 'vsess_marked',
        });
        const marker =
          markerKind === 'wrong-reference'
            ? {
                ...CONTAINMENT_REQUIREMENTS,
                providerRef: encodeVercelProviderRef({
                  sandboxName: requestedSandboxId,
                  sessionId: 'vsess_previous',
                }),
              }
            : markerKind === 'wrong-flags'
              ? { ...CONTAINMENT_REQUIREMENTS, github: false, providerRef }
              : markerKind === 'old-marker'
                ? { kilocode: true, github: true, providerRef }
                : undefined;
        const physical: PhysicalRecord = {
          state: 'running',
          providerRef,
          createIntent: null,
          stopTombstone: null,
          resumable: false,
          ...(marker ? { containment: marker } : {}),
        };
        await seedRunningVercel(instance, state, requestedSandboxId, fakeProvider(), { physical });
        await expect(instance.updateNetworkPolicy(policyUpdateInput())).rejects.toThrow(
          'Sandbox credential containment mismatch'
        );
      });
    }
  );

  it('rejects providers without an exact-session network policy capability', async () => {
    const requestedSandboxId = 'sbx__policy_capability_missing';
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      await seedRunningVercel(
        instance,
        state,
        requestedSandboxId,
        fakeProvider({ updateNetworkPolicy: undefined })
      );
      await expect(instance.updateNetworkPolicy(policyUpdateInput())).rejects.toThrow(
        'Sandbox provider does not support network policy updates'
      );
    });
  });

  it('updates only the exact contained instance without persisting firewall credentials', async () => {
    const requestedSandboxId = 'sbx__policy_exact_update';
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      const updates: Array<{ providerRef: string; networkPolicy: VercelSandboxNetworkPolicy }> = [];
      const provider = fakeProvider({
        async updateNetworkPolicy(providerRef, networkPolicy) {
          updates.push({ providerRef, networkPolicy });
        },
      });
      const providerRef = await seedRunningVercel(instance, state, requestedSandboxId, provider);
      await expect(instance.updateNetworkPolicy(policyUpdateInput())).resolves.toBeUndefined();
      expect(updates).toEqual([{ providerRef, networkPolicy: CONTAINMENT_POLICY }]);
      expect(JSON.stringify([...(await state.storage.list())])).not.toContain(
        'managed-firewall-test-token'
      );
    });
  });

  it('allows an overlapping readiness check to refresh the stateless provider adapter', async () => {
    const {
      control: stub,
      sandboxId: requestedSandboxId,
      registration,
    } = await credentialFixture('vercel');
    await runInDurableObject(stub, async (instance, state) => {
      const replacementProvider = fakeProvider();
      const provider = fakeProvider({
        async updateNetworkPolicy() {
          await expect(
            instance.ensureReady({
              ownerId: CONTAINMENT_OWNER,
              provider: 'vercel',
              allowCreate: false,
              sessionId: registration.identity.sessionId,
            })
          ).resolves.toMatchObject({ physical: 'running' });
        },
      });
      await seedRunningVercel(instance, state, requestedSandboxId, provider);
      Object.assign(instance, {
        pinProvider: async () => {
          Object.assign(instance, { provider: replacementProvider });
          return true;
        },
      });

      await expect(instance.updateNetworkPolicy(policyUpdateInput())).resolves.toBeUndefined();
    });
  });

  it('rejects a physical state change while the provider update is awaiting', async () => {
    const requestedSandboxId = 'sbx__policy_stale_physical';
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      const provider = fakeProvider({
        async updateNetworkPolicy() {
          const physical = await state.storage.get<PhysicalRecord>('physical_record');
          if (!physical) throw new Error('Missing test physical record');
          await state.storage.put('physical_record', { ...physical, state: 'failed' });
        },
      });
      await seedRunningVercel(instance, state, requestedSandboxId, provider);
      await expect(instance.updateNetworkPolicy(policyUpdateInput())).rejects.toThrow(
        'Sandbox instance changed during network policy update'
      );
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({ state: 'failed' });
    });
  });

  it('rejects a provider identity change while the provider update is awaiting', async () => {
    const requestedSandboxId = 'sbx__policy_stale_provider';
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      const provider = fakeProvider({
        async updateNetworkPolicy() {
          await state.storage.put('provider_kind', 'cloudflare');
        },
      });
      await seedRunningVercel(instance, state, requestedSandboxId, provider);
      await expect(instance.updateNetworkPolicy(policyUpdateInput())).rejects.toThrow(
        'Sandbox instance changed during network policy update'
      );
    });
  });
});

describe('SandboxControl contained Vercel lifecycle', () => {
  it.each(['malformed', 'cross-sandbox'] as const)(
    'rejects a %s Vercel handshake before binding a creating instance',
    async identityKind => {
      const requestedSandboxId = `sbx__containment_handshake_${identityKind}`;
      const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
      const credential = generateSandboxCredential();
      const providerInstanceId =
        identityKind === 'malformed'
          ? requestedSandboxId
          : encodeVercelProviderRef({
              sandboxName: 'sbx__someone_else',
              sessionId: 'vsess_other',
            });
      await runInDurableObject(stub, async (instance, state) => {
        await instance.initializeOwner(CONTAINMENT_OWNER);
        await state.storage.put('provider_kind', 'vercel');
        Object.assign(instance, { provider: fakeProvider(), providerKind: 'vercel' });
        await instance.claimCreate('intent_rejected', false, undefined, CONTAINMENT_REQUIREMENTS);
        await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
      });

      const ws = await connect(credential, requestedSandboxId);
      await rejectHello(ws, `hello-rejected-${identityKind}`, providerInstanceId);
      await runInDurableObject(stub, async instance => {
        const physical = await instance.getPhysicalRecord();
        expect(physical).toMatchObject({
          state: 'creating',
          providerRef: null,
          createIntent: { containment: CONTAINMENT_REQUIREMENTS },
        });
        expect(physical.containment).toBeUndefined();
        await expect(instance.getStatus()).resolves.toMatchObject({ connection: 'disconnected' });
      });
    }
  );

  it.each(['stopped', 'creating', 'stopping', 'failed', 'unknown'] as const)(
    'rejects a valid-looking Vercel handshake while the instance is %s',
    async physicalState => {
      const requestedSandboxId = `sbx__containment_handshake_${physicalState}`;
      const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
      const credential = generateSandboxCredential();
      const providerRef = encodeVercelProviderRef({
        sandboxName: requestedSandboxId,
        sessionId: 'vsess_inactive',
      });
      await runInDurableObject(stub, async (instance, state) => {
        await instance.initializeOwner(CONTAINMENT_OWNER);
        await state.storage.put('provider_kind', 'vercel');
        await state.storage.put('physical_record', {
          ...containedRunningRecord(providerRef),
          state: physicalState,
        });
        Object.assign(instance, { provider: fakeProvider(), providerKind: 'vercel' });
        await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
      });

      const ws = await connect(credential, requestedSandboxId);
      await rejectHello(ws, `hello-inactive-${physicalState}`, providerRef);
      await runInDurableObject(stub, async instance => {
        await expect(instance.getPhysicalRecord()).resolves.toMatchObject({ state: physicalState });
      });
    }
  );

  it('preserves the current Vercel socket when a different physical session attempts a handshake', async () => {
    const requestedSandboxId = 'sbx__containment_handshake_stale';
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    const credential = generateSandboxCredential();
    let providerRef = '';
    await runInDurableObject(stub, async (instance, state) => {
      providerRef = await seedRunningVercel(instance, state, requestedSandboxId, fakeProvider());
      await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
    });

    const current = await connect(credential, requestedSandboxId);
    await completeHello(current, 'hello-current-instance', { providerInstanceId: providerRef });
    const stale = await connect(credential, requestedSandboxId);
    await rejectHello(
      stale,
      'hello-stale-instance',
      encodeVercelProviderRef({
        sandboxName: requestedSandboxId,
        sessionId: 'vsess_previous',
      })
    );
    expect(current.readyState).toBe(1);
    await runInDurableObject(stub, async instance => {
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        providerRef,
        containment: { ...CONTAINMENT_REQUIREMENTS, providerRef },
      });
      await expect(instance.getStatus()).resolves.toMatchObject({ connection: 'connected' });
    });

    signalWrapperReady(current);
    await vi.waitFor(async () => {
      await expect(stub.getStatus()).resolves.toMatchObject({ connection: 'ready' });
    });
    const inbound = nextMessage(current);
    const pending = runInDurableObject(stub, instance =>
      instance.request({ operation: 'sandbox.status', payload: {} })
    );
    const request = JSON.parse(await inbound) as { requestId: string };
    current.send(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true }));
    await expect(pending).resolves.toMatchObject({ ok: true });
    current.close();
  });

  it('durably confirms the provider-created instance before its wrapper can launch', async () => {
    const {
      control: stub,
      sandboxId: requestedSandboxId,
      registration,
    } = await credentialFixture('vercel');
    let providerRef = '';
    let credential = '';
    await runInDurableObject(stub, async (instance, state) => {
      const provider = fakeProvider({
        async create(intent) {
          providerRef = encodeVercelProviderRef({
            sandboxName: intent.allocationName ?? requestedSandboxId,
            sessionId: 'vsess_authoritative',
          });
          await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
            state: 'creating',
            providerRef: null,
          });
          return { providerRef };
        },
        async launch(ref, launchEnv) {
          expect(ref).toBe(providerRef);
          await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
            state: 'running',
            providerRef,
            containment: { ...CONTAINMENT_REQUIREMENTS, providerRef },
          });
          credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL ?? '';
        },
      });
      await instance.initializeOwner(CONTAINMENT_OWNER);
      await state.storage.put('provider_kind', 'vercel');
      Object.assign(instance, {
        provider,
        createProviderAdapter: () => provider,
        providerKind: 'vercel',
        pinProvider: async () => true,
      });

      await expect(
        instance.ensureReady({
          ownerId: CONTAINMENT_OWNER,
          provider: 'vercel',
          allowCreate: true,
          sessionId: registration.identity.sessionId,
        })
      ).resolves.toMatchObject({ physical: 'running', connection: 'disconnected' });
    });

    const stale = await connect(credential, requestedSandboxId);
    let current: WebSocket | undefined;
    try {
      await rejectHello(
        stale,
        'hello-authoritative-stale',
        encodeVercelProviderRef({
          sandboxName: requestedSandboxId,
          sessionId: 'vsess_stale',
        })
      );
      current = await connect(credential, requestedSandboxId);
      await completeHello(current, 'hello-authoritative-current', {
        providerInstanceId: providerRef,
      });
    } finally {
      await stub.detachSession(registration.identity.sessionId);
      stale.close();
      current?.close();
    }
  });

  it.each(['wrapper-first', 'provider-first'] as const)(
    'requires authoritative confirmation when startup confirmation is %s',
    async order => {
      const requestedSandboxId = `sbx__containment_${order}`;
      const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
      const credential = generateSandboxCredential();
      const providerRef = encodeVercelProviderRef({
        sandboxName: requestedSandboxId,
        sessionId: `vsess_${order}`,
      });
      await runInDurableObject(stub, async (instance, state) => {
        await instance.initializeOwner(CONTAINMENT_OWNER);
        await state.storage.put('provider_kind', 'vercel');
        Object.assign(instance, { provider: fakeProvider(), providerKind: 'vercel' });
        await instance.claimCreate('intent_race', false, undefined, CONTAINMENT_REQUIREMENTS);
        await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
        if (order === 'provider-first') {
          await instance.confirmInstance(providerRef);
        }
      });

      if (order === 'wrapper-first') {
        const premature = await connect(credential, requestedSandboxId);
        await rejectHello(premature, 'hello-before-confirmation', providerRef);
        await runInDurableObject(stub, async instance => {
          await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
            state: 'creating',
            providerRef: null,
          });
          await instance.confirmInstance(providerRef);
        });
      }
      const ws = await connect(credential, requestedSandboxId);
      await completeHello(ws, `hello-${order}`, { providerInstanceId: providerRef });
      await runInDurableObject(stub, async instance => {
        await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
          state: 'running',
          providerRef,
          createIntent: { intentId: 'intent_race', containment: CONTAINMENT_REQUIREMENTS },
          containment: { ...CONTAINMENT_REQUIREMENTS, providerRef },
        });
      });
      ws.close();
    }
  );

  it('claims creation before credential rotation and fences competing readiness checks', async () => {
    const { control: stub, registration } = await credentialFixture('vercel');
    await runInDurableObject(stub, async (instance, state) => {
      const previousHash = await hashSandboxCredential(generateSandboxCredential());
      await instance.initializeOwner(CONTAINMENT_OWNER);
      await state.storage.put('provider_kind', 'vercel');
      await state.storage.put('wrapper_credential_hash', previousHash);
      await state.storage.put('wrapper_ready_at', 123);
      const input = {
        ownerId: CONTAINMENT_OWNER,
        provider: 'vercel' as const,
        allowCreate: true,
        sessionId: registration.identity.sessionId,
      };
      let creates = 0;
      let claims = 0;
      let competingReadiness: ReturnType<SandboxControl['ensureReady']> | undefined;
      const provider = fakeProvider({
        async create() {
          creates += 1;
          return { unresolved: true };
        },
      });
      const claim = instance.claimCreate.bind(instance);
      Object.assign(instance, {
        provider,
        createProviderAdapter: () => provider,
        providerKind: 'vercel',
        pinProvider: async () => true,
        claimCreate: async (
          intentId: string,
          resumable = false,
          allocationName?: string,
          containment?: CredentialContainmentRequirements
        ) => {
          claims += 1;
          expect(await state.storage.get<string>('wrapper_credential_hash')).toBe(previousHash);
          expect(await state.storage.get<number>('wrapper_ready_at')).toBe(123);
          const claimed = await claim(intentId, resumable, allocationName, containment);
          competingReadiness = instance.ensureReady(input);
          await expect(
            instance.ensureReady({ ...input, ownerId: 'github|oauth:different-user' })
          ).rejects.toThrow('Sandbox owner mismatch');
          return claimed;
        },
      });

      await expect(instance.ensureReady(input)).resolves.toMatchObject({ physical: 'creating' });
      await expect(competingReadiness).resolves.toMatchObject({ physical: 'creating' });
      expect(claims).toBe(1);
      expect(creates).toBe(1);
      expect(await state.storage.get<string>('wrapper_credential_hash')).not.toBe(previousHash);
      expect(await state.storage.get<number>('wrapper_ready_at')).toBeUndefined();
    });
  });

  it.each(['cloudflare', 'vercel'] as const)(
    'joins concurrent %s cold starts after credential preparation',
    async providerKind => {
      const { control, registration, containers, vercel } = await credentialFixture(providerKind);
      const sibling = await registerSiblingWorktree(registration);
      await runInDurableObject(control, async instance => {
        const statuses = await Promise.all(
          [registration, sibling].map(value =>
            instance.ensureReady({
              ...credentialInput(value),
              provider: providerKind,
              allowCreate: true,
            })
          )
        );
        expect(statuses.every(status => ['creating', 'running'].includes(status.physical))).toBe(
          true
        );
        expect(statuses.map(status => status.attachment?.kilo?.scopeId).sort()).toEqual(
          [WORKTREE_ID, OTHER_WORKTREE_ID].sort()
        );
        expect((await instance.getPhysicalRecord()).state).toBe('running');
      });
      expect(providerKind === 'vercel' ? vercel.runtime.creates : containers.launches.length).toBe(
        1
      );
      expect(await storedGrants(control)).toHaveLength(2);
    }
  );

  it.each(['reconciliation', 'detach'] as const)(
    'finishes %s cleanup after a Vercel create fails without a provider reference',
    async cleanup => {
      const { control, registration, vercel } = await credentialFixture('vercel');
      await runInDurableObject(control, async (instance, state) => {
        const observations: Array<string | null> = [];
        const provider = fakeProvider({
          async create() {
            throw new Error('Create rejected before allocating an instance');
          },
          async stop() {
            return 'retryable';
          },
          async observe(ref, intent) {
            observations.push(ref);
            return vercel.provider.observe(ref, intent);
          },
        });
        Object.assign(instance, { createProviderAdapter: () => provider });
        await expect(
          instance.ensureReady({
            ...credentialInput(registration),
            provider: 'vercel',
            allowCreate: true,
          })
        ).resolves.toMatchObject({ physical: 'failed' });
        expect(await instance.getPhysicalRecord()).toMatchObject({ providerRef: null });
        expect(await state.storage.get('credential_policy_dirty')).toBe(true);
        if (cleanup === 'detach') {
          await expect(instance.detachSession(registration.identity.sessionId)).rejects.toThrow(
            'Sandbox credential revocation is pending'
          );
        }
        const physical = await instance.getPhysicalRecord();
        if (!physical.createIntent) throw new Error('Missing retained creation intent');
        const clock = vi
          .spyOn(Date, 'now')
          .mockReturnValue(physical.createIntent.createdAt + DEADLINE_MS.createSettle + 1);
        try {
          await state.storage.put('deadlines', {
            [cleanup === 'detach' ? 'stopAttempt' : 'reconciliation']: Date.now() - 1,
          });
          await instance.alarm();
        } finally {
          clock.mockRestore();
        }
        if (cleanup === 'detach') {
          await expect(instance.detachSession(registration.identity.sessionId)).resolves.toEqual({
            existed: false,
          });
        }
        expect(observations).toEqual(cleanup === 'detach' ? [null, null] : [null]);
        expect(await instance.getPhysicalRecord()).toMatchObject({
          state: 'stopped',
          providerRef: null,
          createIntent: null,
        });
        expect(await loadSessionCredentialGrants(state.storage)).toEqual([]);
        expect(await state.storage.get('credential_policy_dirty')).toBeUndefined();
        expect(await loadDeadlines(state.storage)).not.toHaveProperty('reconciliation');
        expect(await state.storage.getAlarm()).toBeNull();
      });
    }
  );

  it('retains a failed null-reference creation when the provider cannot confirm absence', async () => {
    const { control, registration } = await credentialFixture('vercel');
    await runInDurableObject(control, async (instance, state) => {
      const provider = fakeProvider({
        async create() {
          throw new Error('Create outcome unavailable');
        },
        async observe() {
          return { status: 'unknown' };
        },
      });
      Object.assign(instance, { createProviderAdapter: () => provider });
      await instance.ensureReady({
        ...credentialInput(registration),
        provider: 'vercel',
        allowCreate: true,
      });
      const grants = await loadSessionCredentialGrants(state.storage);
      await state.storage.put('deadlines', { reconciliation: Date.now() - 1 });
      await instance.alarm();
      expect(await instance.getPhysicalRecord()).toMatchObject({
        state: 'unknown',
        providerRef: null,
        stopTombstone: { reason: 'environment_failed' },
      });
      expect(await loadSessionCredentialGrants(state.storage)).toEqual(grants);
      expect(await state.storage.get('credential_policy_dirty')).toBe(true);
      expect((await loadDeadlines(state.storage)).reconciliation).toBeGreaterThan(Date.now());
    });
  });

  it('revokes the previous ready wrapper before provisioning a replacement', async () => {
    const { control, registration, sandboxId, vercel, broker } = await credentialFixture('vercel');
    const input = credentialInput(registration);
    const initial = await control.ensureReady({ ...input, provider: 'vercel', allowCreate: true });
    const payload = initial.attachment;
    if (!payload?.kilo || !payload.git?.token)
      throw new Error('Missing initial contained attachment');
    await control.attachSession(attachInput(registration, payload));
    const launch = vercel.runtime.launches[0];
    const credential = launch.env.SANDBOX_CONTROL_CREDENTIAL;
    const previousRef = launch.env.PROVIDER_INSTANCE_ID;
    const previous = await connect(credential, sandboxId);
    try {
      await completeHello(previous, 'hello-previous-wrapper', { providerInstanceId: previousRef });
      signalWrapperReady(previous);
      await vi.waitFor(async () => {
        await expect(control.getStatus()).resolves.toMatchObject({ connection: 'ready' });
      });
      await runInDurableObject(control, async (instance, state) => {
        const physical = await instance.getPhysicalRecord();
        await state.storage.put('physical_record', { ...physical, state: 'failed' });
      });
      const closed = new Promise<number>(resolve => {
        previous.addEventListener('close', event => resolve(event.code), { once: true });
      });
      const result = await runInDurableObject(control, async (instance, state) => {
        const stoppedRefs: Array<string | null> = [];
        let connectionAtCreate = '';
        let hadReadyMarkerAtCreate = true;
        const createProviderAdapter = (
          _kind: AgentSandboxProvider,
          physical?: PhysicalRecord
        ): ProviderAdapter => {
          const adapter = vercel.createAdapter(physical?.createIntent?.allocationName ?? sandboxId);
          return {
            ...adapter,
            async stop(ref, intent) {
              stoppedRefs.push(ref);
              return adapter.stop(ref, intent);
            },
            async create(intent) {
              connectionAtCreate = (await instance.getStatus()).connection;
              hadReadyMarkerAtCreate =
                (await state.storage.get<number>('wrapper_ready_at')) !== undefined;
              return adapter.create(intent);
            },
          };
        };
        Object.assign(instance, { createProviderAdapter });
        await expect(instance.prepareSessionCredentials(input)).rejects.toThrow(
          'Sandbox credential containment is unavailable'
        );
        expect(await loadSessionCredentialGrants(state.storage)).toHaveLength(1);
        const status = await instance.ensureReady({ ...input, allowCreate: true });
        return {
          status,
          stoppedRefs,
          connectionAtCreate,
          hadReadyMarkerAtCreate,
        };
      });
      await expect(closed).resolves.toBe(4001);
      expect(result.status).toMatchObject({ physical: 'running', connection: 'disconnected' });
      expect(result.connectionAtCreate).toBe('disconnected');
      expect(result.hadReadyMarkerAtCreate).toBe(false);
      expect(result.stoppedRefs).toEqual([previousRef]);
      expect(vercel.runtime.creates).toBe(2);
      const replacementLaunch = vercel.runtime.launches[1];
      expect(replacementLaunch.env.PROVIDER_INSTANCE_ID).not.toBe(previousRef);
      const fresh = result.status.attachment;
      if (!fresh?.kilo || !fresh.git?.token)
        throw new Error('Missing replacement contained attachment');
      expect(fresh.kilo.scopeId).toBe(payload.kilo.scopeId);
      expect(fresh.kilo.token).not.toBe(payload.kilo.token);
      expect(fresh.git.token).not.toBe(payload.git.token);
      expect(fresh.directory).toBe(payload.directory);
      expect(fresh.snapshotIdentity).toBe(ROOT_ID);
      expect(JSON.stringify(fresh)).not.toContain(payload.kilo.token);
      expect(JSON.stringify(fresh)).not.toContain(payload.git.token);
      expectSanitized(fresh, broker);
      const grants = await storedGrants(control);
      expect(grants).toEqual([
        expect.objectContaining({
          scopeId: WORKTREE_ID,
          members: [{ sessionId: input.sessionId, kiloSessionId: ROOT_ID }],
          kilo: expect.objectContaining({ alias: fresh.kilo.token }),
          scm: expect.objectContaining({ alias: fresh.git.token }),
        }),
      ]);
      const exportUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`;
      expect(
        policyAuthorization(vercel.runtime.policy, payload.kilo.token, exportUrl)
      ).toBeUndefined();
      expect(policyAuthorization(vercel.runtime.policy, fresh.kilo.token, exportUrl)).toBe(
        `Bearer ${KILO_TOKEN}`
      );
      expect(
        policyAuthorization(
          vercel.runtime.policy,
          payload.git.token,
          'https://api.github.com/repos/acme/repo'
        )
      ).toBeUndefined();
      expect(
        policyAuthorization(
          vercel.runtime.policy,
          fresh.git.token,
          'https://api.github.com/repos/acme/repo'
        )
      ).toBe(`Bearer ${GITHUB_TOKEN}`);
      const replacement = await connect(
        replacementLaunch.env.SANDBOX_CONTROL_CREDENTIAL,
        sandboxId
      );
      try {
        await completeHello(replacement, 'hello-replacement-wrapper', {
          providerInstanceId: replacementLaunch.env.PROVIDER_INSTANCE_ID,
        });
        signalWrapperReady(replacement);
        await vi.waitFor(async () => {
          await expect(control.getStatus()).resolves.toMatchObject({ connection: 'ready' });
        });
        const attachment = attachInput(registration, fresh);
        await control.attachSession(attachment);
        const inbound = nextMessage(replacement);
        const pending = control.request({
          operation: 'session.attach',
          session: {
            sessionId: attachment.sessionId,
            kiloSessionId: attachment.kiloSessionId,
            directory: attachment.directory,
          },
          payload: fresh,
        });
        const request = JSON.parse(await inbound) as {
          requestId: string;
          payload: SessionAttachPayload;
        };
        expect(request.payload).toEqual(fresh);
        expect(JSON.stringify(request)).not.toContain(payload.kilo.token);
        expect(JSON.stringify(request)).not.toContain(payload.git.token);
        replacement.send(
          JSON.stringify({ type: 'response', requestId: request.requestId, ok: true })
        );
        await expect(pending).resolves.toMatchObject({ ok: true });
        expect(await control.listRoutes()).toEqual([expect.objectContaining(attachment)]);
      } finally {
        replacement.close();
      }
      const rejected = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${credential}` },
      });
      expect(rejected.status).toBe(401);
    } finally {
      previous.close();
    }
  });

  it.each(['unmarked', 'wrong-flags', 'wrong-reference', 'old-marker'] as const)(
    'fails closed and retains the exact reference for a %s warm instance',
    async markerKind => {
      const requestedSandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}` as const;
      const { control: stub, registration } = await credentialFixture('vercel', requestedSandboxId);
      await runInDurableObject(stub, async (instance, state) => {
        const providerRef = encodeVercelProviderRef({
          sandboxName: requestedSandboxId,
          sessionId: 'vsess_warm',
        });
        const marker =
          markerKind === 'wrong-flags'
            ? { kilocode: true, github: false, providerRef }
            : markerKind === 'wrong-reference'
              ? {
                  ...CONTAINMENT_REQUIREMENTS,
                  providerRef: encodeVercelProviderRef({
                    sandboxName: requestedSandboxId,
                    sessionId: 'vsess_previous',
                  }),
                }
              : markerKind === 'old-marker'
                ? { kilocode: true, github: true, providerRef }
                : undefined;
        const physical: PhysicalRecord = {
          state: 'running',
          providerRef,
          createIntent: null,
          stopTombstone: null,
          resumable: false,
          ...(marker ? { containment: marker } : {}),
        };
        let creates = 0;
        const stoppedRefs: Array<string | null> = [];
        const provider = fakeProvider({
          async create() {
            creates += 1;
            return { unresolved: true };
          },
          async stop(ref) {
            stoppedRefs.push(ref);
            return 'retryable';
          },
        });
        await seedRunningVercel(instance, state, requestedSandboxId, provider, {
          physical,
          bypassPin: true,
        });

        const status = await instance.ensureReady({
          ownerId: CONTAINMENT_OWNER,
          provider: 'vercel',
          allowCreate: true,
          sessionId: registration.identity.sessionId,
        });
        expect(status.physical).toBe('stopping');
        await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
          state: 'stopping',
          providerRef,
          stopTombstone: { reason: 'credential_containment_unavailable', attempts: 1 },
        });
        expect(stoppedRefs).toEqual([providerRef]);
        expect(creates).toBe(0);
      });
    }
  );

  it('preserves a newer creation when a stale failed-instance stop completes', async () => {
    const {
      control: stub,
      sandboxId: requestedSandboxId,
      registration,
    } = await credentialFixture('vercel');
    await runInDurableObject(stub, async (instance, state) => {
      const previousRef = encodeVercelProviderRef({
        sandboxName: requestedSandboxId,
        sessionId: 'vsess_previous',
      });
      const replacement = claimCreate(
        initialPhysicalRecord(false),
        'intent_replacement',
        Date.now(),
        undefined,
        CONTAINMENT_REQUIREMENTS
      );
      const stoppedRefs: Array<string | null> = [];
      let creates = 0;
      const provider = fakeProvider({
        async stop(ref) {
          stoppedRefs.push(ref);
          await state.storage.put('physical_record', replacement);
          return 'terminal';
        },
        async create() {
          creates += 1;
          return { unresolved: true };
        },
      });
      await seedRunningVercel(instance, state, requestedSandboxId, provider, {
        bypassPin: true,
        physical: { ...containedRunningRecord(previousRef), state: 'failed' },
      });

      const status = await instance.ensureReady({
        ownerId: CONTAINMENT_OWNER,
        provider: 'vercel',
        allowCreate: true,
        sessionId: registration.identity.sessionId,
      });
      expect(status.physical).toBe('creating');
      await expect(instance.getPhysicalRecord()).resolves.toEqual(replacement);
      expect(stoppedRefs).toEqual([previousRef]);
      expect(creates).toBe(0);
    });
  });

  it('immediately reclaims an unmarked warm Vercel instance using its exact reference', async () => {
    const requestedSandboxId = 'ses-abcd0002';
    const { control: stub, registration } = await credentialFixture('vercel', requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      const providerRef = encodeVercelProviderRef({
        sandboxName: requestedSandboxId,
        sessionId: 'vsess_unmarked',
      });
      const stoppedRefs: Array<string | null> = [];
      let creates = 0;
      const provider = fakeProvider({
        async create() {
          creates += 1;
          return { unresolved: true };
        },
        async stop(ref) {
          stoppedRefs.push(ref);
          return 'terminal';
        },
      });
      await seedRunningVercel(instance, state, requestedSandboxId, provider, {
        bypassPin: true,
        physical: {
          state: 'running',
          providerRef,
          createIntent: null,
          stopTombstone: null,
          resumable: false,
        },
      });

      const status = await instance.ensureReady({
        ownerId: CONTAINMENT_OWNER,
        provider: 'vercel',
        allowCreate: true,
        sessionId: registration.identity.sessionId,
      });
      expect(status.physical).toBe('stopped');
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
      });
      expect(stoppedRefs).toEqual([providerRef]);
      expect(creates).toBe(0);
    });
  });

  it('never issues native cleanup using a logical-name-only Vercel reference', async () => {
    const requestedSandboxId = 'ses-abcd0003';
    const { control: stub, registration } = await credentialFixture('vercel', requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      const nativeCalls: string[] = [];
      const provider = unresolvableVercelProvider(requestedSandboxId, nativeCalls);
      await seedRunningVercel(instance, state, requestedSandboxId, provider, {
        bypassPin: true,
        physical: {
          state: 'running',
          providerRef: requestedSandboxId,
          createIntent: null,
          stopTombstone: null,
          resumable: false,
        },
      });

      const status = await instance.ensureReady({
        ownerId: CONTAINMENT_OWNER,
        provider: 'vercel',
        allowCreate: true,
        sessionId: registration.identity.sessionId,
      });
      expect(status.physical).toBe('stopping');
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopping',
        providerRef: requestedSandboxId,
        stopTombstone: { reason: 'credential_containment_unavailable', attempts: 1 },
      });
      expect(nativeCalls).toEqual([]);
    });
  });

  it('fails closed when an existing creation intent requests different containment', async () => {
    const requestedSandboxId = 'ses-abcd0004';
    const { control: stub, registration } = await credentialFixture('vercel', requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      const physical = claimCreate(initialPhysicalRecord(false), 'intent_previous', 1, undefined, {
        kilocode: false,
        github: true,
      });
      await seedRunningVercel(instance, state, requestedSandboxId, fakeProvider(), {
        physical,
        bypassPin: true,
      });

      const status = await instance.ensureReady({
        ownerId: CONTAINMENT_OWNER,
        provider: 'vercel',
        allowCreate: true,
        sessionId: registration.identity.sessionId,
      });
      expect(status.physical).toBe('stopping');
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopping',
        stopTombstone: { reason: 'credential_containment_unavailable', attempts: 1 },
        createIntent: {
          intentId: 'intent_previous',
          containment: { kilocode: false, github: true },
        },
      });
    });
  });

  it('requires authoritative session credentials even when a valid grant was already stored', async () => {
    const requestedSandboxId = 'ses-abcd0001';
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      let creates = 0;
      const provider = fakeProvider({
        async create() {
          creates += 1;
          return { unresolved: true };
        },
      });
      await instance.initializeOwner(CONTAINMENT_OWNER);
      await state.storage.put('provider_kind', 'vercel');
      Object.assign(instance, {
        provider,
        createProviderAdapter: () => provider,
        providerKind: 'vercel',
        pinProvider: async () => true,
      });
      const grant = await seedGrant(instance, state, undefined, 'vercel');

      await expect(
        instance.ensureReady({
          ownerId: CONTAINMENT_OWNER,
          sessionId: GRANT_SESSION_ID,
          provider: 'vercel',
          allowCreate: true,
        })
      ).rejects.toThrow('Session credential ownership mismatch');
      expect(await loadSessionCredentialGrants(state.storage)).toEqual([grant]);
      expect(await state.storage.get('wrapper_credential_hash')).toBeUndefined();
      expect(creates).toBe(0);
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
        createIntent: null,
        stopTombstone: null,
      });
    });
  });

  it('persists the exact instance before failing a wrapper startup', async () => {
    const {
      control: stub,
      sandboxId: requestedSandboxId,
      registration,
    } = await credentialFixture('vercel');
    await runInDurableObject(stub, async (instance, state) => {
      let providerRef = '';
      let capturedIntent: ProviderCreateIntent | undefined;
      let launchEnv: Record<string, string> | undefined;
      const stoppedRefs: Array<string | null> = [];
      const provider = fakeProvider({
        async create(intent) {
          capturedIntent = intent;
          providerRef = encodeVercelProviderRef({
            sandboxName: intent.allocationName ?? requestedSandboxId,
            sessionId: 'vsess_startup_failed',
          });
          return { providerRef };
        },
        async launch(ref, environment) {
          launchEnv = environment;
          expect(ref).toBe(providerRef);
          await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
            state: 'running',
            providerRef,
          });
          throw new Error('Wrapper startup failed');
        },
        async stop(ref) {
          stoppedRefs.push(ref);
          return 'retryable';
        },
      });
      await instance.initializeOwner(CONTAINMENT_OWNER);
      await state.storage.put('provider_kind', 'vercel');
      Object.assign(instance, {
        provider,
        createProviderAdapter: () => provider,
        providerKind: 'vercel',
        pinProvider: async () => true,
      });

      const status = await instance.ensureReady({
        ownerId: CONTAINMENT_OWNER,
        provider: 'vercel',
        allowCreate: true,
        sessionId: registration.identity.sessionId,
      });
      expect(status.physical).toBe('failed');
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'failed',
        providerRef,
        createIntent: {
          intentId: capturedIntent?.intentId,
          allocationName: capturedIntent?.allocationName,
        },
        containment: { ...CONTAINMENT_REQUIREMENTS, providerRef },
      });
      expect(stoppedRefs).toEqual([]);
      await instance.recordStopAttempt();
      expect(stoppedRefs).toEqual([providerRef]);
      expect(capturedIntent?.networkPolicy).toEqual(
        buildControlNetworkPolicy(await loadSessionCredentialGrants(state.storage))
      );
      expect(launchEnv).toMatchObject({
        SANDBOX_CONTROL_CREDENTIAL: expect.any(String),
        KILO_PLATFORM: 'cloud-agent',
      });
      for (const key of ['KILOCODE_TOKEN', 'KILO_AUTH_CONTENT', 'GH_TOKEN', 'GITHUB_TOKEN']) {
        expect(launchEnv).not.toHaveProperty(key);
      }
      expect(JSON.stringify(launchEnv)).not.toContain(KILO_TOKEN);
    });
  });

  it('stops the exact Vercel instance on the first cleanup attempt when wrapper startup fails', async () => {
    const {
      control: stub,
      sandboxId: requestedSandboxId,
      registration,
    } = await credentialFixture('vercel');
    await runInDurableObject(stub, async (instance, state) => {
      let providerRef = '';
      const stoppedRefs: Array<string | null> = [];
      const provider = fakeProvider({
        async create(intent) {
          providerRef = encodeVercelProviderRef({
            sandboxName: intent.allocationName ?? requestedSandboxId,
            sessionId: 'vsess_startup_reclaimed',
          });
          return { providerRef };
        },
        async launch(ref) {
          expect(ref).toBe(providerRef);
          throw new Error('Wrapper startup failed');
        },
        async stop(ref) {
          stoppedRefs.push(ref);
          return 'terminal';
        },
        async observe() {
          return { status: stoppedRefs.length > 0 ? 'terminal' : 'active' };
        },
      });
      await instance.initializeOwner(CONTAINMENT_OWNER);
      await state.storage.put('provider_kind', 'vercel');
      Object.assign(instance, {
        provider,
        createProviderAdapter: () => provider,
        providerKind: 'vercel',
        pinProvider: async () => true,
      });

      const status = await instance.ensureReady({
        ownerId: CONTAINMENT_OWNER,
        provider: 'vercel',
        allowCreate: true,
        sessionId: registration.identity.sessionId,
      });
      expect(status.physical).toBe('failed');
      await instance.recordStopAttempt();
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
      });
      expect(stoppedRefs).toEqual([providerRef]);
    });
  });

  it('requires worktree containment and a native policy even without an SCM repository', async () => {
    const {
      control: stub,
      sandboxId: requestedSandboxId,
      registration,
      session,
    } = await credentialFixture('vercel');
    await updateCredentialMetadata(session, metadata => ({ ...metadata, repository: undefined }));
    await runInDurableObject(stub, async (instance, state) => {
      let providerRef = '';
      let capturedIntent: ProviderCreateIntent | undefined;
      let launchEnv: Record<string, string> | undefined;
      const provider = fakeProvider({
        async create(intent) {
          capturedIntent = intent;
          providerRef = encodeVercelProviderRef({
            sandboxName: intent.allocationName ?? requestedSandboxId,
            sessionId: 'vsess_github_only',
          });
          return { providerRef };
        },
        async launch(ref, environment) {
          expect(ref).toBe(providerRef);
          launchEnv = environment;
        },
      });
      await instance.initializeOwner(CONTAINMENT_OWNER);
      await state.storage.put('provider_kind', 'vercel');
      Object.assign(instance, {
        provider,
        createProviderAdapter: () => provider,
        providerKind: 'vercel',
        pinProvider: async () => true,
      });

      const status = await instance.ensureReady({
        ownerId: CONTAINMENT_OWNER,
        provider: 'vercel',
        allowCreate: true,
        sessionId: registration.identity.sessionId,
      });
      expect(status.physical).toBe('running');
      expect(status.attachment?.git).toBeUndefined();
      expect(capturedIntent?.networkPolicy).toEqual(
        buildControlNetworkPolicy(await loadSessionCredentialGrants(state.storage))
      );
      expect(launchEnv).not.toHaveProperty('KILOCODE_TOKEN');
      expect(launchEnv).not.toHaveProperty('GH_TOKEN');
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        containment: { ...WORKTREE_CREDENTIAL_CONTAINMENT, providerRef },
      });
    });
  });

  it('confirms a contained Cloudflare reference without launching Kilo or SCM credentials', async () => {
    const {
      control: stub,
      sandboxId: requestedSandboxId,
      registration,
    } = await credentialFixture();
    await runInDurableObject(stub, async (instance, state) => {
      let capturedIntent: ProviderCreateIntent | undefined;
      let launchEnv: Record<string, string> | undefined;
      let providerRef = '';
      const provider = fakeProvider({
        async create(intent) {
          capturedIntent = intent;
          providerRef = cloudflareRef(intent.allocationName ?? requestedSandboxId, intent.intentId);
          return { providerRef };
        },
        async launch(ref, environment) {
          expect(ref).toBe(providerRef);
          launchEnv = environment;
          await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
            state: 'running',
            providerRef,
            containment: { ...WORKTREE_CREDENTIAL_CONTAINMENT, providerRef },
          });
        },
      });
      await instance.initializeOwner(CONTAINMENT_OWNER);
      await state.storage.put('provider_kind', 'cloudflare');
      Object.assign(instance, {
        provider,
        createProviderAdapter: () => provider,
        pinProvider: async () => true,
      });

      const status = await instance.ensureReady({
        ownerId: CONTAINMENT_OWNER,
        sessionId: registration.identity.sessionId,
        provider: 'cloudflare',
        allowCreate: true,
      });
      expect(status.physical).toBe('running');
      expect(capturedIntent?.networkPolicy).toBeUndefined();
      expect(launchEnv).not.toHaveProperty('KILOCODE_TOKEN');
      expect(launchEnv).not.toHaveProperty('GH_TOKEN');
      expect(JSON.stringify(launchEnv)).not.toContain(KILO_TOKEN);
    });
  });
});

describe('SandboxControl mandatory worktree credentials', () => {
  it('joins authoritative session metadata, native containment, wrapper handshake, and sanitized attach', async () => {
    const fixture = await credentialFixture();
    const { control, registration, broker, containers } = fixture;
    const input = credentialInput(registration);
    expect(await storedGrants(control)).toEqual([]);
    const ready = await control.ensureReady({ ...input, allowCreate: true });
    expect(ready).toMatchObject({ physical: 'running', connection: 'disconnected' });
    const payload = ready.attachment;
    if (!payload?.kilo) throw new Error('Missing contained readiness attachment');
    const [grant] = await storedGrants(control);
    expect(grant).toBeDefined();
    expect(payload.kilo).toEqual({
      scopeId: WORKTREE_ID,
      token: grant.kilo.alias,
      targets: CONTAINMENT_TARGETS,
    });
    expect(payload.env).toMatchObject({
      KILOCODE_TOKEN: grant.kilo.alias,
      GH_TOKEN: grant.scm?.alias,
      PUBLIC_VALUE: 'preserved',
      KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: grant.kilo.alias } }),
    });
    expect(payload.git).toEqual({
      url: 'https://github.com/acme/repo.git',
      platform: 'github',
      token: grant.scm?.alias,
    });
    expect(payload.setupCommands).toEqual([`fixture-command --credential=${grant.kilo.alias}`]);
    expect(broker.kiloSubjects.get(grant.kilo.capabilities[input.sessionId].credential)).toEqual({
      userId: input.ownerId,
      cloudAgentSessionId: input.sessionId,
      kiloSessionId: ROOT_ID,
      outboundContainerId: fixture.outboundContainerId,
      userToken: KILO_TOKEN,
      targets: CONTAINMENT_TARGETS,
    });
    expect(grant.scm?.capability?.credential).toMatch(/^kgh2\./);
    expectSanitized(payload, broker);

    expect(containers.launches).toHaveLength(1);
    const launch = containers.launches[0];
    const providerRef = launch.env.PROVIDER_INSTANCE_ID;
    const intent = launch.physical.createIntent;
    expect(intent?.allocationName).not.toBe(fixture.sandboxId);
    expect(decodeCloudflareProviderRef(providerRef)).toEqual({
      sandboxId: intent?.allocationName,
      containment: true,
      instanceId: intent?.intentId,
    });
    expect(launch).toMatchObject({
      containerId: fixture.outboundContainerId,
      outboundHandler: MANAGED_SCM_OUTBOUND_HANDLER,
      physical: {
        state: 'running',
        providerRef,
        createIntent: intent,
        containment: { ...WORKTREE_CREDENTIAL_CONTAINMENT, providerRef },
      },
    });
    expectCredentialFreeLaunch(launch, broker);
    const ws = await connect(launch.env.SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
    try {
      await completeHello(ws, 'hello-joined-containment', { providerInstanceId: providerRef });
      const stale = await connect(launch.env.SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
      await rejectHello(
        stale,
        'hello-stale-cloudflare-instance',
        cloudflareRef(fixture.sandboxId, 'previous')
      );
      expect(ws.readyState).toBe(1);
      signalWrapperReady(ws);
      await vi.waitFor(async () => {
        await expect(control.getStatus()).resolves.toMatchObject({ connection: 'ready' });
      });
      const attachment = attachInput(registration, payload);
      await expect(control.attachSession(attachment)).resolves.toMatchObject(attachment);
      const inbound = nextMessage(ws);
      const pending = control.request({
        operation: 'session.attach',
        session: {
          sessionId: attachment.sessionId,
          kiloSessionId: attachment.kiloSessionId,
          directory: attachment.directory,
        },
        payload,
      });
      const request = JSON.parse(await inbound) as {
        requestId: string;
        operation: string;
        payload: SessionAttachPayload;
      };
      expect(request).toMatchObject({ operation: 'session.attach', payload });
      expectSanitized(request, broker);
      ws.send(JSON.stringify({ type: 'response', requestId: request.requestId, ok: true }));
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(await control.listRoutes()).toEqual([expect.objectContaining(attachment)]);
      expectSanitized(await control.getTransitionLog(), broker);
    } finally {
      ws.close();
    }
  });

  it('shares stable aliases across two roots of one worktree without granting access to another worktree', async () => {
    const fixture = await credentialFixture();
    const { control, registration, broker } = fixture;
    const second: CredentialRegistration = {
      ...registration,
      identity: { ...registration.identity, sessionId: `workspace_${crypto.randomUUID()}` },
      auth: { ...registration.auth, kiloSessionId: SECOND_ROOT_ID },
    };
    const other: CredentialRegistration = {
      ...registration,
      identity: { ...registration.identity, sessionId: `workspace_${crypto.randomUUID()}` },
      auth: { ...registration.auth, kiloSessionId: THIRD_ROOT_ID },
      repository: { type: 'github', repo: 'acme/other' },
      workspace: {
        ...registration.workspace,
        workspacePath: '/workspace/other',
        worktreeId: OTHER_WORKTREE_ID,
      },
    };
    await registerCredentialSession(second);
    await registerCredentialSession(other);
    const firstPayload = await readyAttachment(control, credentialInput(registration));
    const secondPayload = await readyAttachment(control, credentialInput(second));
    const otherPayload = await readyAttachment(control, credentialInput(other));
    expect(secondPayload.kilo).toEqual(firstPayload.kilo);
    expect(secondPayload.git?.token).toBe(firstPayload.git?.token);
    expect(otherPayload.kilo?.token).not.toBe(firstPayload.kilo?.token);
    expect(otherPayload.git?.token).not.toBe(firstPayload.git?.token);
    expect(await readyAttachment(control, credentialInput(second))).toEqual(secondPayload);
    await control.ensureReady({ ...credentialInput(registration), allowCreate: true });
    for (const [data, payload] of [
      [registration, firstPayload],
      [second, secondPayload],
      [other, otherPayload],
    ] as const) {
      await control.attachSession(attachInput(data, payload));
    }
    expect(await control.listRoutes()).toHaveLength(3);
    const grants = await storedGrants(control);
    expect(grants).toHaveLength(2);
    const shared = grants.find(grant => grant.scopeId === WORKTREE_ID);
    const separate = grants.find(grant => grant.scopeId === OTHER_WORKTREE_ID);
    if (!shared || !separate) throw new Error('Missing worktree grants');
    expect(shared.members).toEqual([
      { sessionId: registration.identity.sessionId, kiloSessionId: ROOT_ID },
      { sessionId: second.identity.sessionId, kiloSessionId: SECOND_ROOT_ID },
    ]);
    const outboundContainerId = fixture.outboundContainerId;
    for (const [sessionId, root] of [
      [registration.identity.sessionId, ROOT_ID],
      [second.identity.sessionId, SECOND_ROOT_ID],
    ]) {
      for (const [operation, method] of [
        ['export', 'GET'],
        ['ingest', 'POST'],
      ]) {
        const resolved = await control.resolveCredential({
          credential: shared.kilo.alias,
          outboundContainerId,
          url: `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${root}/${operation}`,
          method,
        });
        expect(resolved).toEqual({
          credential: shared.kilo.capabilities[sessionId].credential,
          organizationId: registration.identity.orgId,
        });
        expect(resolved && broker.kiloSubjects.get(resolved.credential)).toMatchObject({
          cloudAgentSessionId: sessionId,
          kiloSessionId: root,
        });
      }
    }
    for (const [alias, root] of [
      [shared.kilo.alias, THIRD_ROOT_ID],
      [separate.kilo.alias, ROOT_ID],
    ]) {
      await expect(
        control.resolveCredential({
          credential: alias,
          outboundContainerId,
          url: `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${root}/export`,
          method: 'GET',
        })
      ).resolves.toBeNull();
    }
    for (const grant of [shared, separate]) {
      if (!grant.scm) throw new Error('Missing SCM grant');
      const resolved = await control.resolveCredential({
        credential: grant.scm.alias,
        outboundContainerId,
        url: 'https://api.github.com/user',
        method: 'GET',
      });
      expect(resolved).toEqual({ credential: grant.scm.capability?.credential });
      expect(resolved && broker.githubSubjects.get(resolved.credential)).toMatchObject({
        githubRepo: grant.repository?.type === 'github' ? grant.repository.repo : '',
        outboundContainerId,
        userId: registration.identity.userId,
      });
    }
    await control.detachSession(registration.identity.sessionId);
    const afterFirstDetach = (await storedGrants(control)).find(
      grant => grant.scopeId === WORKTREE_ID
    );
    expect(afterFirstDetach?.kilo.alias).toBe(shared.kilo.alias);
    expect(afterFirstDetach?.members).toEqual([
      { sessionId: second.identity.sessionId, kiloSessionId: SECOND_ROOT_ID },
    ]);
    expect(afterFirstDetach?.kilo.capabilities[registration.identity.sessionId]).toBeUndefined();
    await expect(
      control.resolveCredential({
        credential: shared.kilo.alias,
        outboundContainerId,
        url: `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`,
        method: 'GET',
      })
    ).resolves.toBeNull();
    await expect(
      control.resolveCredential({
        credential: shared.kilo.alias,
        outboundContainerId,
        url: `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${SECOND_ROOT_ID}/export`,
        method: 'GET',
      })
    ).resolves.toMatchObject({
      credential: shared.kilo.capabilities[second.identity.sessionId].credential,
    });
    await expect(async () =>
      control.attachSession(attachInput(registration, firstPayload))
    ).rejects.toThrow('Session has no matching worktree credential grant');
    await control.detachSession(second.identity.sessionId);
    expect(await storedGrants(control)).toEqual([separate]);
    await expect(
      control.resolveCredential({
        credential: shared.scm?.alias ?? '',
        outboundContainerId,
        url: 'https://api.github.com/repos/acme/repo',
        method: 'GET',
      })
    ).resolves.toBeNull();
    expect(await control.listRoutes()).toEqual([
      expect.objectContaining(attachInput(other, otherPayload)),
    ]);
    await control.beginStop('test');
    await control.confirmStopped();
    expect(await storedGrants(control)).toEqual([]);
    await expect(
      control.resolveCredential({
        credential: separate.kilo.alias,
        outboundContainerId,
        url: `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${THIRD_ROOT_ID}/export`,
        method: 'GET',
      })
    ).resolves.toBeNull();
  });

  it('refreshes an expired warm lease and broker capabilities without replacing aliases or the physical instance', async () => {
    const fixture = await credentialFixture();
    const { control, registration, broker, containers } = fixture;
    const input = credentialInput(registration);
    const initial = await control.ensureReady({ ...input, allowCreate: true });
    const initialPayload = initial.attachment;
    if (!initialPayload?.kilo) throw new Error('Missing initial contained attachment');
    await control.attachSession(attachInput(registration, initialPayload));
    const physical = await control.getPhysicalRecord();
    const [original] = await storedGrants(control);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(original.preparedAt + 5 * HOUR);
    try {
      const request = {
        credential: original.kilo.alias,
        outboundContainerId: fixture.outboundContainerId,
        url: `${CONTAINMENT_TARGETS.providerBaseUrl}/api/openrouter/chat/completions`,
        method: 'POST',
      };
      await expect(control.resolveCredential(request)).resolves.toBeNull();
      const ready = await control.ensureReady({ ...input, allowCreate: false });
      expect(ready.physical).toBe('running');
      const payload = ready.attachment;
      expect(payload).toEqual(initialPayload);
      expect(await control.getPhysicalRecord()).toEqual(physical);
      expect(containers.launches).toHaveLength(1);
      const [renewed] = await storedGrants(control);
      expect(renewed.expiresAt).toBe(original.preparedAt + 9 * HOUR);
      expect(renewed.kilo.capabilities[input.sessionId].credential).not.toBe(
        original.kilo.capabilities[input.sessionId].credential
      );
      expect(renewed.scm?.capability?.credential).not.toBe(original.scm?.capability?.credential);
      await expect(control.resolveCredential(request)).resolves.toEqual({
        credential: renewed.kilo.capabilities[input.sessionId].credential,
        organizationId: registration.identity.orgId,
      });
      expectSanitized(payload, broker);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['deleted', 'revoked'] as const)(
    'does not prepare or resolve credentials after the authoritative session is %s',
    async action => {
      const fixture = await credentialFixture();
      const { control, registration, session } = fixture;
      const input = credentialInput(registration);
      const payload = await readyAttachment(control, input);
      await control.ensureReady({ ...input, allowCreate: true });
      await control.attachSession(attachInput(registration, payload));
      if (action === 'deleted') await session.deleteSession();
      else await session.closeOrgStreams(registration.identity.orgId ?? '');
      expect(await session.getCredentialMetadata()).toBeNull();
      await expect(async () => control.prepareSessionCredentials(input)).rejects.toThrow(
        'Session credential ownership mismatch'
      );
      await expect(async () =>
        control.ensureReady({ ...input, allowCreate: true })
      ).rejects.toThrow('Session credential ownership mismatch');
      expect(await storedGrants(control)).toEqual([]);
      expect(await control.listRoutes()).toEqual([]);
      await expect(
        control.resolveCredential({
          credential: payload.kilo?.token ?? '',
          outboundContainerId: fixture.outboundContainerId,
          url: `${CONTAINMENT_TARGETS.providerBaseUrl}/api/openrouter/chat/completions`,
          method: 'POST',
        })
      ).resolves.toBeNull();
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({ state: 'running' });
    }
  );

  it.each(['missing-binding', 'missing-github-rpc', 'raw-github-result'] as const)(
    'fails closed before provisioning when the broker has %s',
    async mode => {
      const fixture = await credentialFixture();
      const { control, registration, broker, containers, environment } = fixture;
      if (mode === 'missing-binding') Object.assign(environment, { GIT_TOKEN_SERVICE: undefined });
      else if (mode === 'missing-github-rpc') {
        Object.assign(broker.binding, { issueGitHubSessionCapability: undefined });
      } else {
        const issue = broker.binding.issueGitHubSessionCapability.bind(broker.binding);
        broker.binding.issueGitHubSessionCapability = async subject => ({
          ...(await issue(subject)),
          success: true,
          capability: GITHUB_TOKEN,
          installationId: '42',
          accountLogin: 'acme',
          appType: 'standard',
          source: 'installation',
          gitAuthor: { name: 'fixture bot', email: 'fixture@example.com' },
        });
      }
      const input = credentialInput(registration);
      const error =
        mode === 'missing-binding'
          ? 'Kilo capability issuance is unavailable'
          : mode === 'missing-github-rpc'
            ? 'GitHub capability issuance is unavailable'
            : 'Invalid contained worktree credentials';
      await expect(async () => control.prepareSessionCredentials(input)).rejects.toThrow(
        'Sandbox credential containment is unavailable'
      );
      await expect(async () =>
        control.ensureReady({ ...input, allowCreate: true })
      ).rejects.toThrow(error);
      expect(await storedGrants(control)).toEqual([]);
      expect(containers.launches).toEqual([]);
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'failed',
        createIntent: { containment: WORKTREE_CREDENTIAL_CONTAINMENT },
        stopTombstone: { reason: 'environment_failed' },
      });
      await finishFailedCreation(control);
    }
  );

  it.each(['owner', 'session', 'sandbox', 'missing'] as const)(
    'rejects authoritative %s metadata mismatches',
    async mismatch => {
      const fixture = await credentialFixture();
      const { control, registration, session, broker } = fixture;
      if (mismatch !== 'missing') {
        await updateCredentialMetadata(session, metadata => ({
          ...metadata,
          identity: {
            ...metadata.identity,
            ...(mismatch === 'owner' ? { userId: 'other-owner' } : {}),
            ...(mismatch === 'session' ? { sessionId: `workspace_${crypto.randomUUID()}` } : {}),
          },
          workspace: {
            ...metadata.workspace,
            ...(mismatch === 'sandbox' ? { sandboxId: 'usr-deadbeef' } : {}),
          },
        }));
      }
      const input = {
        ...credentialInput(registration),
        ...(mismatch === 'missing' ? { sessionId: `workspace_${crypto.randomUUID()}` } : {}),
      };
      await expect(async () => control.prepareSessionCredentials(input)).rejects.toThrow(
        'Session credential ownership mismatch'
      );
      await expect(async () =>
        control.ensureReady({ ...input, allowCreate: true })
      ).rejects.toThrow('Session credential ownership mismatch');
      expect(await storedGrants(control)).toEqual([]);
      expect(broker.kiloSubjects.size).toBe(0);
      expect(broker.githubSubjects.size).toBe(0);
      expect(fixture.containers.launches).toEqual([]);
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
        createIntent: null,
        stopTombstone: null,
      });
    }
  );

  it('rejects metadata changes while broker issuance is in flight without publishing a grant', async () => {
    const fixture = await credentialFixture();
    const { control, registration, session, broker } = fixture;
    const issue = broker.binding.issueKiloSessionCapability.bind(broker.binding);
    broker.binding.issueKiloSessionCapability = async subject => {
      const currentSession = env.SANDBOX_SESSION.getByName(
        `${registration.identity.userId}:${registration.identity.sessionId}`
      );
      await updateCredentialMetadata(currentSession, metadata => ({
        ...metadata,
        workspace: { ...metadata.workspace, workspacePath: '/workspace/replaced' },
      }));
      return issue(subject);
    };
    await expect(async () =>
      control.ensureReady({ ...credentialInput(registration), allowCreate: true })
    ).rejects.toThrow('Session changed during credential preparation');
    await expect(session.getCredentialMetadata()).resolves.toMatchObject({
      workspace: { workspacePath: '/workspace/replaced' },
    });
    expect(await storedGrants(control)).toEqual([]);
    expect(fixture.containers.launches).toEqual([]);
    broker.binding.issueKiloSessionCapability = issue;
    await finishFailedCreation(control);
    const ready = await control.ensureReady({
      ...credentialInput(registration),
      allowCreate: true,
    });
    expect(ready).toMatchObject({
      physical: 'running',
      attachment: { directory: '/workspace/replaced', kilo: { scopeId: WORKTREE_ID } },
    });
    expect((await storedGrants(control))[0]?.directory).toBe('/workspace/replaced');
    expect(fixture.containers.launches).toHaveLength(1);
  });

  it('prepares a session-scoped grant and attaches without an explicit worktree id', async () => {
    const { control, registration, session } = await credentialFixture();
    await updateCredentialMetadata(session, metadata => ({
      ...metadata,
      workspace: { ...metadata.workspace, worktreeId: undefined },
    }));
    const payload = await readyAttachment(control, credentialInput(registration));
    expect(payload.kilo?.scopeId).toBe(registration.identity.sessionId);
    const attachment = {
      ...credentialInput(registration),
      kiloSessionId: ROOT_ID,
      directory: '/workspace/joined',
    };
    await expect(control.attachSession(attachment)).resolves.toMatchObject(attachment);
    const routes = await control.listRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]).not.toHaveProperty('worktreeId');
  });

  it.each(['directory', 'root'] as const)(
    'rejects a %s already granted to another worktree without changing the existing grant',
    async conflict => {
      const { control, registration } = await credentialFixture();
      await readyAttachment(control, credentialInput(registration));
      const original = await storedGrants(control);
      const second: CredentialRegistration = {
        ...registration,
        identity: { ...registration.identity, sessionId: `workspace_${crypto.randomUUID()}` },
        auth: {
          ...registration.auth,
          kiloSessionId: conflict === 'root' ? ROOT_ID : SECOND_ROOT_ID,
        },
        workspace: {
          ...registration.workspace,
          worktreeId: OTHER_WORKTREE_ID,
          workspacePath: conflict === 'directory' ? '/workspace/joined' : '/workspace/other',
        },
      };
      await registerCredentialSession(second);
      await expect(async () =>
        control.prepareSessionCredentials(credentialInput(second))
      ).rejects.toThrow('Worktree credential scope mismatch');
      expect(await storedGrants(control)).toEqual(original);
      await expect(async () =>
        control.ensureReady({ ...credentialInput(second), allowCreate: true })
      ).rejects.toThrow('Worktree credential scope mismatch');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({ state: 'running' });
      expect(await storedGrants(control)).toEqual(original);
    }
  );

  it('cannot refresh expired broker capabilities without a broker or extend the worktree lease during resolution', async () => {
    const { control, registration, environment } = await credentialFixture();
    const input = credentialInput(registration);
    await readyAttachment(control, input);
    await control.ensureReady({ ...input, allowCreate: true });
    const [grant] = await storedGrants(control);
    Object.assign(environment, { GIT_TOKEN_SERVICE: undefined });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(grant.preparedAt + 3 * HOUR + 1);
    try {
      for (const [credential, url] of [
        [
          grant.kilo.alias,
          `${CONTAINMENT_TARGETS.providerBaseUrl}/api/openrouter/chat/completions`,
        ],
        [grant.scm?.alias ?? '', 'https://api.github.com/repos/acme/repo'],
      ]) {
        await expect(
          control.resolveCredential({
            credential,
            url,
            outboundContainerId: grant.outboundContainerId ?? '',
            method: 'POST',
          })
        ).resolves.toBeNull();
      }
      expect(await storedGrants(control)).toEqual([grant]);
    } finally {
      clock.mockRestore();
    }
  });

  it('enforces the complete live grant identity before changing the route table', async () => {
    const { control, registration } = await credentialFixture();
    const payload = await readyAttachment(control, credentialInput(registration));
    const attachment = attachInput(registration, payload);
    await control.attachSession(attachment);
    for (const invalid of [
      { ...attachment, sessionId: `workspace_${crypto.randomUUID()}` },
      { ...attachment, kiloSessionId: SECOND_ROOT_ID },
      { ...attachment, directory: '/workspace/wrong' },
      { ...attachment, worktreeId: OTHER_WORKTREE_ID },
      { ...attachment, worktreeId: undefined },
    ]) {
      await expect(async () => control.attachSession(invalid)).rejects.toThrow(
        'Session has no matching worktree credential grant'
      );
    }
    await expect(async () =>
      control.attachSession({ ...attachment, ownerId: 'other-owner' })
    ).rejects.toThrow('Sandbox owner mismatch');
    expect(await control.listRoutes()).toEqual([expect.objectContaining(attachment)]);
    const [grant] = await storedGrants(control);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt);
    try {
      await expect(async () => control.attachSession(attachment)).rejects.toThrow(
        'Session has no matching worktree credential grant'
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('pins provider identity for preparation and readiness and fails closed without Vercel configuration', async () => {
    const fixture = await credentialFixture('cloudflare', 'ses-b001');
    const input = credentialInput(fixture.registration);
    await readyAttachment(fixture.control, input);
    await expect(async () =>
      fixture.control.ensureReady({ ...input, provider: 'vercel', allowCreate: true })
    ).rejects.toThrow('Sandbox provider mismatch');
    await updateCredentialMetadata(fixture.session, metadata => ({
      ...metadata,
      workspace: { ...metadata.workspace, sandboxProvider: 'vercel' },
    }));
    await expect(async () => fixture.control.prepareSessionCredentials(input)).rejects.toThrow(
      'Sandbox provider mismatch'
    );
    expect(fixture.containers.launches).toHaveLength(1);
    const vercel = await credentialFixture('vercel');
    Object.assign(vercel.environment, { VERCEL_TOKEN: undefined });
    await expect(async () =>
      vercel.control.prepareSessionCredentials(credentialInput(vercel.registration))
    ).rejects.toThrow('Vercel sandbox runtime configuration is unavailable');
    expect(await storedGrants(vercel.control)).toEqual([]);
    expect(vercel.vercel.runtime.creates).toBe(0);
  });

  it('resolves only the exact alias, native binding, current physical instance, and permitted Kilo routes', async () => {
    const fixture = await credentialFixture();
    const { control, registration } = fixture;
    const payload = await readyAttachment(control, credentialInput(registration));
    await control.ensureReady({ ...credentialInput(registration), allowCreate: true });
    const input = {
      credential: payload.kilo?.token ?? '',
      outboundContainerId: fixture.outboundContainerId,
      url: `${CONTAINMENT_TARGETS.providerBaseUrl}/api/openrouter/chat/completions`,
      method: 'POST',
    };
    const [grant] = await storedGrants(control);
    await expect(control.resolveCredential(input)).resolves.toEqual({
      credential: grant.kilo.capabilities[registration.identity.sessionId].credential,
      organizationId: registration.identity.orgId,
    });
    for (const invalid of [
      { ...input, credential: createControlPlaneCredential(fixture.sandboxId, 'kilo') },
      { ...input, credential: createControlPlaneCredential('usr-deadbeef', 'kilo') },
      { ...input, credential: KILO_TOKEN },
      { ...input, credential: grant.kilo.capabilities[registration.identity.sessionId].credential },
      { ...input, outboundContainerId: `standard:${fixture.sandboxId}` },
      { ...input, outboundContainerId: 'contained:usr-deadbeef' },
      { ...input, url: 'https://untrusted.example.com/api/openrouter/chat/completions' },
      {
        ...input,
        url: `${CONTAINMENT_TARGETS.backendBaseUrl}/api/organizations/other/defaults`,
        method: 'GET',
      },
      { ...input, url: `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session`, method: 'GET' },
      {
        ...input,
        url: `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`,
        method: 'POST',
      },
      { ...input, method: 'DELETE' },
    ]) {
      await expect(control.resolveCredential(invalid)).resolves.toBeNull();
    }
    await control.beginStop('test');
    await expect(control.resolveCredential(input)).resolves.toBeNull();
    await control.confirmStopped();
    expect(await storedGrants(control)).toEqual([]);
  });

  it('discards a capability resolution when its physical instance is superseded during refresh', async () => {
    const fixture = await credentialFixture();
    const { control, registration, broker } = fixture;
    const payload = await readyAttachment(control, credentialInput(registration));
    await control.ensureReady({ ...credentialInput(registration), allowCreate: true });
    const [grant] = await storedGrants(control);
    const issue = broker.binding.issueKiloSessionCapability.bind(broker.binding);
    await runInDurableObject(control, (_instance, state) => {
      broker.binding.issueKiloSessionCapability = async subject => {
        await state.storage.put(
          'physical_record',
          containedRunningRecord(cloudflareRef(fixture.sandboxId, 'replacement'))
        );
        return issue(subject);
      };
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(grant.preparedAt + 3 * HOUR + 1);
    try {
      await expect(
        control.resolveCredential({
          credential: payload.kilo?.token ?? '',
          outboundContainerId: fixture.outboundContainerId,
          url: `${CONTAINMENT_TARGETS.providerBaseUrl}/api/openrouter/chat/completions`,
          method: 'POST',
        })
      ).resolves.toBeNull();
      expect(await storedGrants(control)).toEqual([grant]);
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        providerRef: cloudflareRef(fixture.sandboxId, 'replacement'),
      });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('SandboxControl native worktree containment', () => {
  it('installs, refreshes, and removes the combined Vercel policy for exact worktree roots', async () => {
    const fixture = await credentialFixture('vercel');
    const { control, registration, session, broker, vercel } = fixture;
    const second: CredentialRegistration = {
      ...registration,
      identity: { ...registration.identity, sessionId: `workspace_${crypto.randomUUID()}` },
      auth: { ...registration.auth, kiloSessionId: SECOND_ROOT_ID },
    };
    const other: CredentialRegistration = {
      ...registration,
      identity: { ...registration.identity, sessionId: `workspace_${crypto.randomUUID()}` },
      auth: { ...registration.auth, kiloSessionId: THIRD_ROOT_ID },
      repository: { type: 'github', repo: 'acme/other' },
      workspace: {
        ...registration.workspace,
        worktreeId: OTHER_WORKTREE_ID,
        workspacePath: '/workspace/other',
      },
    };
    await registerCredentialSession(second);
    await registerCredentialSession(other);
    const firstPayload = await readyAttachment(control, credentialInput(registration));
    const secondPayload = await readyAttachment(control, credentialInput(second));
    const otherPayload = await readyAttachment(control, credentialInput(other));
    expect(firstPayload.kilo).toEqual(secondPayload.kilo);
    await control.ensureReady({ ...credentialInput(registration), allowCreate: true });
    for (const [data, payload] of [
      [registration, firstPayload],
      [second, secondPayload],
      [other, otherPayload],
    ] as const) {
      await control.attachSession(attachInput(data, payload));
      expectSanitized(payload, broker);
    }
    expect(vercel.runtime.creates).toBe(1);
    expect(vercel.runtime.launches).toHaveLength(1);
    const launch = vercel.runtime.launches[0];
    const providerRef = encodeVercelProviderRef({
      sandboxName: launch.physical.createIntent?.allocationName ?? '',
      sessionId: 'vsess_joined_1',
    });
    expect(launch.physical).toMatchObject({
      state: 'running',
      providerRef,
      containment: { ...WORKTREE_CREDENTIAL_CONTAINMENT, providerRef },
    });
    expect(launch.env.PROVIDER_INSTANCE_ID).toBe(providerRef);
    expect(launch.physical.createIntent?.allocationName).not.toBe(fixture.sandboxId);
    expect(
      policyAuthorization(
        launch.networkPolicy,
        firstPayload.kilo?.token ?? '',
        `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`
      )
    ).toBe(`Bearer ${KILO_TOKEN}`);
    expect(
      policyAuthorization(
        launch.networkPolicy,
        secondPayload.kilo?.token ?? '',
        `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${SECOND_ROOT_ID}/export`
      )
    ).toBeUndefined();
    expectCredentialFreeLaunch(launch, broker);
    expect(broker.kiloSubjects.size).toBe(0);
    expect(broker.githubSubjects.size).toBe(0);
    const alias = firstPayload.kilo?.token ?? '';
    const otherAlias = otherPayload.kilo?.token ?? '';
    const ingestUrl = (root: string) =>
      `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${root}/export`;
    expect(policyAuthorization(vercel.runtime.policy, alias, ingestUrl(ROOT_ID))).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    expect(policyAuthorization(vercel.runtime.policy, alias, ingestUrl(SECOND_ROOT_ID))).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    expect(policyAuthorization(vercel.runtime.policy, otherAlias, ingestUrl(THIRD_ROOT_ID))).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    expect(
      policyAuthorization(vercel.runtime.policy, alias, ingestUrl(THIRD_ROOT_ID))
    ).toBeUndefined();
    expect(
      policyAuthorization(vercel.runtime.policy, otherAlias, ingestUrl(ROOT_ID))
    ).toBeUndefined();
    expect(
      policyAuthorization(
        vercel.runtime.policy,
        firstPayload.git?.token ?? '',
        'https://api.github.com/repos/acme/repo'
      )
    ).toBe(`Bearer ${GITHUB_TOKEN}`);
    expect(
      policyAuthorization(
        vercel.runtime.policy,
        firstPayload.git?.token ?? '',
        'https://api.github.com/repos/acme/other'
      )
    ).toBeUndefined();
    await expect(
      control.resolveCredential({
        credential: alias,
        outboundContainerId: `contained-small:${fixture.sandboxId}`,
        url: ingestUrl(ROOT_ID),
        method: 'GET',
      })
    ).resolves.toBeNull();
    const ws = await connect(launch.env.SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
    await completeHello(ws, 'hello-native-vercel', { providerInstanceId: providerRef });
    captureAndAcceptControlRequests(ws);

    const rotatedKiloToken = 'fixture-rotated-kilo-token';
    broker.tokens.github = 'fixture-rotated-github-token';
    await updateCredentialMetadata(session, metadata => ({
      ...metadata,
      auth: { ...metadata.auth, kilocodeToken: rotatedKiloToken },
    }));
    const ready = await control.ensureReady({
      ...credentialInput(registration),
      allowCreate: false,
    });
    const refreshed = ready.attachment;
    if (!refreshed?.kilo) throw new Error('Missing refreshed native attachment');
    expect(refreshed.kilo).toEqual(firstPayload.kilo);
    expect(refreshed.git).toEqual(firstPayload.git);
    expect(policyAuthorization(vercel.runtime.policy, alias, ingestUrl(ROOT_ID))).toBe(
      `Bearer ${rotatedKiloToken}`
    );
    expect(policyAuthorization(vercel.runtime.policy, alias, ingestUrl(SECOND_ROOT_ID))).toBe(
      `Bearer ${rotatedKiloToken}`
    );
    expect(policyAuthorization(vercel.runtime.policy, otherAlias, ingestUrl(THIRD_ROOT_ID))).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    expect(
      policyAuthorization(
        vercel.runtime.policy,
        firstPayload.git?.token ?? '',
        'https://api.github.com/repos/acme/repo'
      )
    ).toBe(`Bearer ${broker.tokens.github}`);
    expect(JSON.stringify(refreshed)).not.toContain(rotatedKiloToken);
    expectSanitized(refreshed, broker);
    expect(vercel.runtime.creates).toBe(1);

    await control.detachSession(registration.identity.sessionId);
    expect(policyAuthorization(vercel.runtime.policy, alias, ingestUrl(ROOT_ID))).toBeUndefined();
    expect(policyAuthorization(vercel.runtime.policy, alias, ingestUrl(SECOND_ROOT_ID))).toBe(
      `Bearer ${rotatedKiloToken}`
    );
    await control.detachSession(second.identity.sessionId);
    expect(
      policyAuthorization(vercel.runtime.policy, alias, ingestUrl(SECOND_ROOT_ID))
    ).toBeUndefined();
    expect(
      policyAuthorization(
        vercel.runtime.policy,
        firstPayload.git?.token ?? '',
        'https://api.github.com/repos/acme/repo'
      )
    ).toBeUndefined();
    expect(policyAuthorization(vercel.runtime.policy, otherAlias, ingestUrl(THIRD_ROOT_ID))).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    expect(await control.listRoutes()).toEqual([
      expect.objectContaining(attachInput(other, otherPayload)),
    ]);
    await control.detachSession(other.identity.sessionId);
    expect(vercel.runtime.policy).toEqual({
      mode: 'custom',
      allowedDomains: ['*'],
      injectionRules: [],
    });
    expect(await storedGrants(control)).toEqual([]);
    await expect(control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'running',
      providerRef,
    });
    ws.close();
  });

  it('uses the latest grants when another worktree prepares during Vercel creation', async () => {
    const fixture = await credentialFixture('vercel');
    const { control, registration, vercel } = fixture;
    const second: CredentialRegistration = {
      ...registration,
      identity: { ...registration.identity, sessionId: `workspace_${crypto.randomUUID()}` },
      auth: { ...registration.auth, kiloSessionId: SECOND_ROOT_ID },
      workspace: {
        ...registration.workspace,
        worktreeId: OTHER_WORKTREE_ID,
        workspacePath: '/workspace/other',
      },
    };
    await registerCredentialSession(second);
    let secondPayload: SessionAttachPayload | undefined;
    await runInDurableObject(control, instance => {
      vercel.runtime.beforeLaunch = async () => {
        secondPayload = await instance.prepareSessionCredentials(credentialInput(second));
      };
    });
    const first = await readyAttachment(control, credentialInput(registration));
    if (!secondPayload?.kilo) throw new Error('Second worktree was not prepared during creation');
    const url = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${SECOND_ROOT_ID}/export`;
    expect(
      policyAuthorization(vercel.runtime.launches[0].networkPolicy, secondPayload.kilo.token, url)
    ).toBeUndefined();
    expect(policyAuthorization(vercel.runtime.policy, secondPayload.kilo.token, url)).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    expect(
      policyAuthorization(vercel.runtime.policy, first.kilo?.token ?? '', url)
    ).toBeUndefined();
    expect(await storedGrants(control)).toHaveLength(2);
    expect(vercel.runtime.creates).toBe(1);
  });

  it('acknowledges Vercel detach after failed policy revocation authoritatively stops the exact runtime', async () => {
    const { control, registration, vercel } = await credentialFixture('vercel');
    const payload = await readyAttachment(control, credentialInput(registration));
    if (!payload.kilo) throw new Error('Missing contained attachment');
    await control.ensureReady({ ...credentialInput(registration), allowCreate: true });
    await control.attachSession(attachInput(registration, payload));
    const physical = await control.getPhysicalRecord();
    const exportUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`;
    await expect(vercel.provider.observe(physical.providerRef)).resolves.toMatchObject({
      status: 'active',
    });
    expect(policyAuthorization(vercel.runtime.policy, payload.kilo.token, exportUrl)).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    vercel.runtime.failPolicy = true;
    await expect(control.detachSession(registration.identity.sessionId)).resolves.toEqual({
      existed: true,
    });
    expect(await storedGrants(control)).toEqual([]);
    expect(await control.listRoutes()).toEqual([]);
    await expect(control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopped',
      providerRef: null,
    });
    await expect(vercel.provider.observe(physical.providerRef)).resolves.toMatchObject({
      status: 'terminal',
    });
    expect(new Set(vercel.runtime.stoppedSessions)).toEqual(new Set(['vsess_joined_1']));
    expect(policyAuthorization(vercel.runtime.policy, payload.kilo.token, exportUrl)).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    await runInDurableObject(control, async (_instance, state) => {
      expect(await state.storage.get('credential_policy_dirty')).not.toBeTruthy();
    });
  });

  it('does not acknowledge repeated detach while a failed Vercel policy still authorizes the removed alias', async () => {
    const { control, registration, vercel } = await credentialFixture('vercel');
    const ready = await control.ensureReady({
      ...credentialInput(registration),
      provider: 'vercel',
      allowCreate: true,
    });
    const payload = ready.attachment;
    if (!payload?.kilo) throw new Error('Missing contained attachment');
    await control.attachSession(attachInput(registration, payload));
    const physical = await control.getPhysicalRecord();
    const exportUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`;
    expect(policyAuthorization(vercel.runtime.policy, payload.kilo.token, exportUrl)).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    vercel.runtime.failPolicy = true;
    vercel.runtime.failStop = true;
    await expect(async () =>
      control.detachSession(registration.identity.sessionId)
    ).rejects.toThrow('Sandbox credential revocation is pending');
    expect(await storedGrants(control)).toEqual([]);
    expect(await control.listRoutes()).toEqual([]);
    await expect(control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopping',
      providerRef: physical.providerRef,
      stopTombstone: { reason: 'environment_failed' },
    });
    await expect(vercel.provider.observe(physical.providerRef)).resolves.toMatchObject({
      status: 'active',
    });
    expect(policyAuthorization(vercel.runtime.policy, payload.kilo.token, exportUrl)).toBe(
      `Bearer ${KILO_TOKEN}`
    );

    await expect(async () =>
      control.detachSession(registration.identity.sessionId)
    ).rejects.toThrow('Sandbox credential revocation is pending');
    await runInDurableObject(control, async (_instance, state) => {
      expect(await state.storage.get('credential_policy_dirty')).toBeTruthy();
    });
    await expect(vercel.provider.observe(physical.providerRef)).resolves.toMatchObject({
      status: 'active',
    });
    expect(policyAuthorization(vercel.runtime.policy, payload.kilo.token, exportUrl)).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    expect(vercel.runtime.stoppedSessions).toEqual([]);
    vercel.runtime.failStop = false;
    await fireControlDeadline(control, 'stopAttempt');
    await expect(control.detachSession(registration.identity.sessionId)).resolves.toEqual({
      existed: false,
    });
    await expect(control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopped',
      providerRef: null,
    });
    expect(new Set(vercel.runtime.stoppedSessions)).toEqual(new Set(['vsess_joined_1']));
    expect(await storedGrants(control)).toEqual([]);
    await runInDurableObject(control, async (_instance, state) => {
      expect(await state.storage.get('credential_policy_dirty')).not.toBeTruthy();
    });
    await expect(vercel.provider.observe(physical.providerRef)).resolves.toMatchObject({
      status: 'terminal',
    });
  });

  it('reapplies a persisted dirty Vercel policy after membership removal even when retry detach changes nothing', async () => {
    const { control, registration, vercel } = await credentialFixture('vercel');
    const sibling = await registerSiblingWorktree(registration);
    const first = await control.ensureReady({
      ...credentialInput(registration),
      provider: 'vercel',
      allowCreate: true,
    });
    const second = await control.ensureReady({ ...credentialInput(sibling), allowCreate: false });
    const firstPayload = first.attachment;
    const secondPayload = second.attachment;
    if (!firstPayload?.kilo || !secondPayload?.kilo) throw new Error('Missing sibling attachments');
    await control.attachSession(attachInput(registration, firstPayload));
    await control.attachSession(attachInput(sibling, secondPayload));
    const physical = await control.getPhysicalRecord();
    const originalGrants = await storedGrants(control);
    const siblingGrants = originalGrants.filter(grant => grant.scopeId === OTHER_WORKTREE_ID);
    const firstUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`;
    const secondUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${SECOND_ROOT_ID}/export`;
    await runInDurableObject(control, async (_instance, state) => {
      await state.storage.put('credential_policy_dirty', true);
      await saveSessionCredentialGrants(state.storage, siblingGrants);
      const routes = await loadRouteTable(state.storage);
      routes.delete(registration.identity.sessionId);
      await saveRouteTable(state.storage, routes);
    });
    expect(await storedGrants(control)).toEqual(siblingGrants);
    expect(policyAuthorization(vercel.runtime.policy, firstPayload.kilo.token, firstUrl)).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    await expect(control.detachSession(registration.identity.sessionId)).resolves.toEqual({
      existed: false,
    });
    expect(
      policyAuthorization(vercel.runtime.policy, firstPayload.kilo.token, firstUrl)
    ).toBeUndefined();
    expect(
      policyAuthorization(
        vercel.runtime.policy,
        firstPayload.git?.token ?? '',
        'https://api.github.com/repos/acme/repo'
      )
    ).toBeUndefined();
    expect(policyAuthorization(vercel.runtime.policy, secondPayload.kilo.token, secondUrl)).toBe(
      `Bearer ${KILO_TOKEN}`
    );
    expect(
      policyAuthorization(
        vercel.runtime.policy,
        secondPayload.git?.token ?? '',
        'https://api.github.com/repos/acme/repo'
      )
    ).toBe(`Bearer ${GITHUB_TOKEN}`);
    expect(await control.getPhysicalRecord()).toEqual(physical);
    expect(await storedGrants(control)).toEqual(siblingGrants);
    expect(await control.listRoutes()).toEqual([
      expect.objectContaining(attachInput(sibling, secondPayload)),
    ]);
    await runInDurableObject(control, async (_instance, state) => {
      expect(await state.storage.get('credential_policy_dirty')).not.toBeTruthy();
    });
  });

  it('durably schedules the earliest future Vercel grant expiry after preparation and renewal', async () => {
    const { control, registration, vercel } = await credentialFixture('vercel');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const first = await control.ensureReady({
        ...credentialInput(registration),
        provider: 'vercel',
        allowCreate: true,
      });
      const afterFirst = await credentialExpiryDeadline(control);
      const sibling = await registerSiblingWorktree(registration);
      clock.mockReturnValue(start + HOUR);
      const second = await control.ensureReady({ ...credentialInput(sibling), allowCreate: false });
      const afterSibling = await credentialExpiryDeadline(control);
      clock.mockReturnValue(start + 2 * HOUR);
      const renewed = await control.ensureReady({
        ...credentialInput(registration),
        allowCreate: false,
      });
      const afterRenewal = await credentialExpiryDeadline(control);
      expect(renewed.attachment?.kilo).toEqual(first.attachment?.kilo);
      const grants = await storedGrants(control);
      expect(grants.find(grant => grant.scopeId === WORKTREE_ID)?.expiresAt).toBe(start + 6 * HOUR);
      expect(grants.find(grant => grant.scopeId === OTHER_WORKTREE_ID)?.expiresAt).toBe(
        start + 5 * HOUR
      );
      expect(
        policyAuthorization(
          vercel.runtime.policy,
          renewed.attachment?.kilo?.token ?? '',
          `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`
        )
      ).toBe(`Bearer ${KILO_TOKEN}`);
      expect(
        policyAuthorization(
          vercel.runtime.policy,
          second.attachment?.kilo?.token ?? '',
          `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${SECOND_ROOT_ID}/export`
        )
      ).toBe(`Bearer ${KILO_TOKEN}`);
      expect([afterFirst, afterSibling, afterRenewal]).toEqual([
        start + 4 * HOUR,
        start + 4 * HOUR,
        start + 5 * HOUR,
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it('expires native Vercel rules without preparing again while preserving a live sibling and renewable aliases', async () => {
    const { control, registration, vercel } = await credentialFixture('vercel');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const first = await control.ensureReady({
        ...credentialInput(registration),
        provider: 'vercel',
        allowCreate: true,
      });
      const sibling = await registerSiblingWorktree(registration);
      clock.mockReturnValue(start + HOUR);
      const second = await control.ensureReady({ ...credentialInput(sibling), allowCreate: false });
      const firstPayload = first.attachment;
      const secondPayload = second.attachment;
      if (!firstPayload?.kilo || !secondPayload?.kilo)
        throw new Error('Missing expiring attachments');
      await control.attachSession(attachInput(registration, firstPayload));
      await control.attachSession(attachInput(sibling, secondPayload));
      const physical = await control.getPhysicalRecord();
      const originalGrants = await storedGrants(control);
      const firstUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`;
      const secondUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${SECOND_ROOT_ID}/export`;
      expect(policyAuthorization(vercel.runtime.policy, firstPayload.kilo.token, firstUrl)).toBe(
        `Bearer ${KILO_TOKEN}`
      );
      expect(policyAuthorization(vercel.runtime.policy, secondPayload.kilo.token, secondUrl)).toBe(
        `Bearer ${KILO_TOKEN}`
      );
      clock.mockReturnValue(start + 4 * HOUR);
      await runCredentialExpiryAlarm(control);

      expect(
        policyAuthorization(vercel.runtime.policy, firstPayload.kilo.token, firstUrl)
      ).toBeUndefined();
      expect(
        policyAuthorization(
          vercel.runtime.policy,
          firstPayload.git?.token ?? '',
          'https://api.github.com/repos/acme/repo'
        )
      ).toBeUndefined();
      expect(policyAuthorization(vercel.runtime.policy, secondPayload.kilo.token, secondUrl)).toBe(
        `Bearer ${KILO_TOKEN}`
      );
      expect(
        policyAuthorization(
          vercel.runtime.policy,
          secondPayload.git?.token ?? '',
          'https://api.github.com/repos/acme/repo'
        )
      ).toBe(`Bearer ${GITHUB_TOKEN}`);
      expect(await storedGrants(control)).toEqual(originalGrants);
      expect(await control.getPhysicalRecord()).toEqual(physical);
      await expect(vercel.provider.observe(physical.providerRef)).resolves.toMatchObject({
        status: 'active',
      });
      expect(await credentialExpiryDeadline(control)).toBe(start + 5 * HOUR);
      await runInDurableObject(control, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBe(start + 5 * HOUR);
        expect(await state.storage.get('credential_policy_dirty')).not.toBeTruthy();
      });

      const renewed = await control.ensureReady({
        ...credentialInput(registration),
        allowCreate: false,
      });
      expect(renewed.attachment?.kilo).toEqual(firstPayload.kilo);
      expect(renewed.attachment?.git).toEqual(firstPayload.git);
      expect(policyAuthorization(vercel.runtime.policy, firstPayload.kilo.token, firstUrl)).toBe(
        `Bearer ${KILO_TOKEN}`
      );
      expect(policyAuthorization(vercel.runtime.policy, secondPayload.kilo.token, secondUrl)).toBe(
        `Bearer ${KILO_TOKEN}`
      );
      expect(await control.getPhysicalRecord()).toEqual(physical);
      expect(await credentialExpiryDeadline(control)).toBe(start + 5 * HOUR);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps expiry due when a grant expires during the native policy PUT and cancels after removing the final rules', async () => {
    const { control, registration, vercel } = await credentialFixture('vercel');
    const start = Date.now();
    const expiry = start + 4 * HOUR;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const first = await control.ensureReady({
        ...credentialInput(registration),
        provider: 'vercel',
        allowCreate: true,
      });
      const sibling = await registerSiblingWorktree(registration);
      clock.mockReturnValue(start + 1_000);
      const second = await control.ensureReady({ ...credentialInput(sibling), allowCreate: false });
      const firstPayload = first.attachment;
      const secondPayload = second.attachment;
      if (!firstPayload?.kilo || !secondPayload?.kilo)
        throw new Error('Missing expiring attachments');
      const physical = await control.getPhysicalRecord();
      const originalGrants = await storedGrants(control);
      expect(originalGrants.find(grant => grant.scopeId === WORKTREE_ID)?.expiresAt).toBe(expiry);
      expect(originalGrants.find(grant => grant.scopeId === OTHER_WORKTREE_ID)?.expiresAt).toBe(
        expiry + 1_000
      );
      expect(await credentialExpiryDeadline(control)).toBe(expiry);
      const firstUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`;
      const secondUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${SECOND_ROOT_ID}/export`;
      let submittedPolicy: VercelSandboxNetworkPolicy | undefined;
      let dirtyDuringPut: boolean | undefined;
      await runInDurableObject(control, (_instance, state) => {
        vercel.runtime.beforePolicyUpdate = async policy => {
          submittedPolicy = policy;
          dirtyDuringPut = await state.storage.get<boolean>('credential_policy_dirty');
          clock.mockReturnValue(expiry + 2_000);
        };
      });
      clock.mockReturnValue(expiry);
      await runCredentialExpiryAlarm(control);
      vercel.runtime.beforePolicyUpdate = undefined;

      expect(Date.now()).toBe(expiry + 2_000);
      expect(dirtyDuringPut).toBe(true);
      expect(submittedPolicy).toEqual(vercel.runtime.policy);
      expect(
        policyAuthorization(submittedPolicy, firstPayload.kilo.token, firstUrl)
      ).toBeUndefined();
      expect(policyAuthorization(submittedPolicy, secondPayload.kilo.token, secondUrl)).toBe(
        `Bearer ${KILO_TOKEN}`
      );
      expect(
        policyAuthorization(
          submittedPolicy,
          secondPayload.git?.token ?? '',
          'https://api.github.com/repos/acme/repo'
        )
      ).toBe(`Bearer ${GITHUB_TOKEN}`);
      expect(await credentialExpiryDeadline(control)).toBe(expiry + 1_000);
      expect(await credentialExpiryDeadline(control)).toBeLessThan(Date.now());
      await runInDurableObject(control, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBe(expiry + 1_000);
        expect(await state.storage.get('credential_policy_dirty')).not.toBeTruthy();
      });
      expect(await storedGrants(control)).toEqual(originalGrants);
      expect(await control.getPhysicalRecord()).toEqual(physical);

      await runCredentialExpiryAlarm(control);
      expect(vercel.runtime.policy).toEqual({
        mode: 'custom',
        allowedDomains: ['*'],
        injectionRules: [],
      });
      expect(
        policyAuthorization(vercel.runtime.policy, secondPayload.kilo.token, secondUrl)
      ).toBeUndefined();
      expect(
        policyAuthorization(
          vercel.runtime.policy,
          secondPayload.git?.token ?? '',
          'https://api.github.com/repos/acme/repo'
        )
      ).toBeUndefined();
      expect(await credentialExpiryDeadline(control)).toBeUndefined();
      await runInDurableObject(control, async (instance, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
        expect(await state.storage.get('credential_policy_dirty')).not.toBeTruthy();
        await instance.alarm();
        expect(await state.storage.getAlarm()).toBeNull();
      });
      expect(await storedGrants(control)).toEqual(originalGrants);
      expect(await control.getPhysicalRecord()).toEqual(physical);
      await expect(vercel.provider.observe(physical.providerRef)).resolves.toMatchObject({
        status: 'active',
      });
    } finally {
      vercel.runtime.beforePolicyUpdate = undefined;
      clock.mockRestore();
    }
  });

  it('stops the exact Vercel runtime when expired credential rules cannot be revoked', async () => {
    const { control, registration, vercel } = await credentialFixture('vercel');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const ready = await control.ensureReady({
        ...credentialInput(registration),
        provider: 'vercel',
        allowCreate: true,
      });
      const physical = await control.getPhysicalRecord();
      const exportUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`;
      expect(
        policyAuthorization(vercel.runtime.policy, ready.attachment?.kilo?.token ?? '', exportUrl)
      ).toBe(`Bearer ${KILO_TOKEN}`);
      vercel.runtime.failPolicy = true;
      clock.mockReturnValue(start + 4 * HOUR);
      await runCredentialExpiryAlarm(control);
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
      });
      await expect(vercel.provider.observe(physical.providerRef)).resolves.toMatchObject({
        status: 'terminal',
      });
      expect(new Set(vercel.runtime.stoppedSessions)).toEqual(new Set(['vsess_joined_1']));
      expect(await storedGrants(control)).toEqual([]);
      expect(await credentialExpiryDeadline(control)).toBeUndefined();
      await runInDurableObject(control, async (_instance, state) => {
        expect(await state.storage.get('credential_policy_dirty')).not.toBeTruthy();
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('observes terminal Vercel cleanup at credential expiry after the reconciliation cutoff', async () => {
    const { control, registration, vercel } = await credentialFixture('vercel');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await readyAttachment(control, credentialInput(registration));
      vercel.runtime.failStop = true;
      await control.beginStop('environment_failed');
      for (let attempt = 0; attempt < DEADLINE_MS.stopAttemptLadder.length; attempt++) {
        await fireControlDeadline(control, 'stopAttempt');
      }
      const retired = await control.getPhysicalRecord();
      expect(retired).toMatchObject({ state: 'unknown', stopTombstone: { attempts: 5 } });
      clock.mockReturnValue(start + DEADLINE_MS.reconciliationWindow);
      await fireControlDeadline(control, 'reconciliation');
      const expiry = await credentialExpiryDeadline(control);
      if (expiry === undefined) throw new Error('Missing credential expiry');
      await runInDurableObject(control, async (instance, state) => {
        expect(await loadDeadlines(state.storage)).toEqual({ credentialExpiry: expiry });
        const provider = {
          ...vercel.provider,
          observe: vi.fn<ProviderAdapter['observe']>(async () => ({ status: 'terminal' })),
          stop: vi.fn<ProviderAdapter['stop']>(async () => 'retryable'),
        };
        Object.assign(instance, { provider });
        clock.mockReturnValue(expiry);
        await instance.alarm();
        expect(await instance.getPhysicalRecord()).toMatchObject({
          state: 'stopped',
          providerRef: null,
          createIntent: null,
          stopTombstone: null,
        });
        expect(provider.observe).toHaveBeenCalledExactlyOnceWith(
          retired.providerRef,
          retired.createIntent
        );
        expect(provider.stop).not.toHaveBeenCalled();
        expect(await loadSessionCredentialGrants(state.storage)).toEqual([]);
        expect(await state.storage.get('credential_policy_dirty')).toBeUndefined();
        expect(await loadDeadlines(state.storage)).toEqual({});
        expect(await state.storage.getAlarm()).toBeNull();
      });
      expect(vercel.runtime.creates).toBe(1);
      expect(vercel.runtime.launches).toHaveLength(1);
      expect(vercel.runtime.stoppedSessions).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['active', 'unknown', 'error'] as const)(
    'keeps Vercel credential expiry fail-closed after the cutoff when observation is %s',
    async observation => {
      const { control, registration, vercel } = await credentialFixture('vercel');
      const start = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
      try {
        await readyAttachment(control, credentialInput(registration));
        const grants = await storedGrants(control);
        vercel.runtime.failStop = true;
        await control.beginStop('environment_failed');
        for (let attempt = 0; attempt < DEADLINE_MS.stopAttemptLadder.length; attempt++) {
          await fireControlDeadline(control, 'stopAttempt');
        }
        const retired = await control.getPhysicalRecord();
        expect(retired).toMatchObject({ state: 'unknown', stopTombstone: { attempts: 5 } });
        clock.mockReturnValue(start + DEADLINE_MS.reconciliationWindow);
        await fireControlDeadline(control, 'reconciliation');
        const expiry = await credentialExpiryDeadline(control);
        if (expiry === undefined) throw new Error('Missing credential expiry');
        await runInDurableObject(control, async (instance, state) => {
          const provider = {
            ...vercel.provider,
            observe: vi.fn<ProviderAdapter['observe']>(async () => {
              if (observation === 'error') throw new Error('Provider observation unavailable');
              return { status: observation };
            }),
            stop: vi.fn<ProviderAdapter['stop']>(async () => 'terminal'),
            updateNetworkPolicy: vi.fn(async () => undefined),
          };
          Object.assign(instance, { provider });
          clock.mockReturnValue(expiry);
          await instance.alarm();
          expect(await instance.getPhysicalRecord()).toEqual(retired);
          expect(await loadSessionCredentialGrants(state.storage)).toEqual(grants);
          expect(await state.storage.get('credential_policy_dirty')).toBe(true);
          expect(await loadDeadlines(state.storage)).toEqual({
            credentialExpiry: expiry + DEADLINE_MS.reconciliation,
          });
          expect(await state.storage.getAlarm()).toBe(expiry + DEADLINE_MS.reconciliation);
          expect(provider.observe).toHaveBeenCalledExactlyOnceWith(
            retired.providerRef,
            retired.createIntent
          );
          expect(provider.stop).not.toHaveBeenCalled();
          expect(provider.updateNetworkPolicy).not.toHaveBeenCalled();
        });
        expect(vercel.runtime.creates).toBe(1);
        expect(vercel.runtime.launches).toHaveLength(1);
        expect(vercel.runtime.stoppedSessions).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    }
  );

  it.each(['terminal', 'error'] as const)(
    'fences a late Vercel credential-expiry observation %s from a replacement allocation',
    async observation => {
      const { control, registration, vercel } = await credentialFixture('vercel');
      const start = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
      try {
        await readyAttachment(control, credentialInput(registration));
        vercel.runtime.failStop = true;
        await control.beginStop('environment_failed');
        for (let attempt = 0; attempt < DEADLINE_MS.stopAttemptLadder.length; attempt++) {
          await fireControlDeadline(control, 'stopAttempt');
        }
        const retired = await control.getPhysicalRecord();
        clock.mockReturnValue(start + DEADLINE_MS.reconciliationWindow);
        await fireControlDeadline(control, 'reconciliation');
        const expiry = await credentialExpiryDeadline(control);
        if (expiry === undefined) throw new Error('Missing credential expiry');
        await runInDurableObject(control, async (instance, state) => {
          let replacement: PhysicalRecord | undefined;
          let replacementGrants: SessionCredentialGrant[] | undefined;
          let replacementDeadlines: DeadlineTable | undefined;
          let replacementAlarm: number | null | undefined;
          const provider = {
            ...vercel.provider,
            observe: vi.fn<ProviderAdapter['observe']>(async () => {
              await instance.confirmStopped();
              replacement = await instance.claimCreate(
                crypto.randomUUID(),
                false,
                `ses-${crypto.randomUUID().replaceAll('-', '')}`,
                WORKTREE_CREDENTIAL_CONTAINMENT
              );
              await instance.prepareSessionCredentials(credentialInput(registration));
              replacementGrants = await loadSessionCredentialGrants(state.storage);
              replacementDeadlines = await loadDeadlines(state.storage);
              replacementAlarm = await state.storage.getAlarm();
              if (observation === 'error') throw new Error('Old provider observation unavailable');
              return { status: observation };
            }),
            stop: vi.fn<ProviderAdapter['stop']>(async () => 'terminal'),
          };
          Object.assign(instance, { provider });
          clock.mockReturnValue(expiry);
          await instance.alarm();
          expect(replacement).toMatchObject({ state: 'creating', stopTombstone: null });
          expect(await instance.getPhysicalRecord()).toEqual(replacement);
          expect(await loadSessionCredentialGrants(state.storage)).toEqual(replacementGrants);
          expect(await state.storage.get('credential_policy_dirty')).toBe(true);
          expect(await loadDeadlines(state.storage)).toEqual(replacementDeadlines);
          expect(await state.storage.getAlarm()).toBe(replacementAlarm);
          expect(provider.observe).toHaveBeenCalledExactlyOnceWith(
            retired.providerRef,
            retired.createIntent
          );
          expect(provider.stop).not.toHaveBeenCalled();
        });
        expect(vercel.runtime.creates).toBe(1);
        expect(vercel.runtime.launches).toHaveLength(1);
        expect(vercel.runtime.stoppedSessions).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    }
  );

  it.each(['resolve', 'reject'] as const)(
    'does not retire a replacement allocation after a late Vercel policy %s',
    async completion => {
      const { control, registration, vercel } = await credentialFixture('vercel');
      await control.ensureReady({
        ...credentialInput(registration),
        provider: 'vercel',
        allowCreate: true,
      });
      await runInDurableObject(control, async instance => {
        let replacement: PhysicalRecord | undefined;
        vercel.runtime.beforePolicyUpdate = async () => {
          await instance.beginStop('old_policy_allocation_retired');
          await expect(instance.recordStopAttempt()).resolves.toMatchObject({ state: 'stopped' });
          replacement = await instance.claimCreate(
            crypto.randomUUID(),
            false,
            `ses-${crypto.randomUUID().replaceAll('-', '')}`,
            WORKTREE_CREDENTIAL_CONTAINMENT
          );
          expect(replacement.state).toBe('creating');
          if (completion === 'reject') throw new Error('Old allocation policy rejected');
        };
        const outcome = await instance.detachSession(registration.identity.sessionId).then(
          result => ({ status: 'fulfilled', result }),
          error => ({ status: 'rejected', error })
        );
        expect(replacement).toBeDefined();
        await expect(instance.getPhysicalRecord()).resolves.toEqual(replacement);
        expect(outcome).toEqual({ status: 'fulfilled', result: { existed: false } });
      });
    }
  );

  it.each(['resolve', 'startup-failed', 'reject'] as const)(
    'fences a late Cloudflare create %s after its confirmed instance has been replaced',
    async completion => {
      const { control, registration, containers, sandboxId, broker } = await credentialFixture();
      const deferred = Promise.withResolvers<ProviderCreateResult>();
      const launchDeferred = Promise.withResolvers<void>();
      let firstResult: ProviderCreateResult | undefined;
      let firstIntentId: string | undefined;
      let native: ProviderAdapter | undefined;
      await runInDurableObject(control, instance => {
        const factory = instance as unknown as {
          createProviderAdapter(
            kind: AgentSandboxProvider,
            physical?: PhysicalRecord
          ): ProviderAdapter;
        };
        const createAdapter = factory.createProviderAdapter.bind(instance);
        Object.assign(instance, {
          createProviderAdapter: (
            kind: AgentSandboxProvider,
            physical?: PhysicalRecord
          ): ProviderAdapter => {
            const adapter = createAdapter(kind, physical);
            native = adapter;
            return {
              ...adapter,
              async create(intent) {
                firstIntentId ??= intent.intentId;
                const result = await adapter.create(intent);
                if (intent.intentId === firstIntentId) {
                  firstResult = result;
                  if (completion !== 'startup-failed') return deferred.promise;
                }
                return result;
              },
              async launch(ref, environment) {
                await adapter.launch(ref, environment);
                if (
                  completion === 'startup-failed' &&
                  decodeCloudflareProviderRef(ref)?.instanceId === firstIntentId
                ) {
                  await launchDeferred.promise;
                }
              },
            };
          },
        });
      });
      const input = { ...credentialInput(registration), allowCreate: true };
      const pending = Promise.resolve(control.ensureReady(input)).then(
        status => ({ type: 'resolved' as const, status }),
        error => ({
          type: 'rejected' as const,
          error: error instanceof Error ? error.message : String(error),
        })
      );
      let currentSocket: WebSocket | undefined;
      try {
        await vi.waitFor(() => expect(firstResult).toBeDefined());
        if (!firstResult || !('providerRef' in firstResult))
          throw new Error('First instance was not confirmed');
        const firstRef = firstResult.providerRef;
        if (completion === 'startup-failed') {
          await vi.waitFor(() => expect(containers.launches).toHaveLength(1));
          await expect(control.getPhysicalRecord()).resolves.toMatchObject({
            state: 'running',
            providerRef: firstRef,
            containment: { ...WORKTREE_CREDENTIAL_CONTAINMENT, providerRef: firstRef },
          });
        } else {
          await expect(control.getPhysicalRecord()).resolves.toMatchObject({
            state: 'creating',
            providerRef: null,
            createIntent: { intentId: firstIntentId },
          });
          expect(containers.launches).toEqual([]);
        }
        const [firstGrant] = await storedGrants(control);
        if (!firstGrant?.scm) throw new Error('Missing first instance credentials');
        await control.markFailed();
        const firstPhysical = await control.getPhysicalRecord();
        if (!firstPhysical.createIntent) throw new Error('Missing first allocation intent');
        const clock = vi
          .spyOn(Date, 'now')
          .mockReturnValue(firstPhysical.createIntent.createdAt + DEADLINE_MS.createSettle + 1);
        try {
          await control.recordStopAttempt();
        } finally {
          clock.mockRestore();
        }
        await expect(control.getPhysicalRecord()).resolves.toMatchObject({ state: 'stopped' });
        const replacement = await control.ensureReady(input);
        const attachment = replacement.attachment;
        if (!attachment?.kilo || !attachment.git?.token)
          throw new Error('Missing replacement credentials');
        const physical = await control.getPhysicalRecord();
        if (!physical.providerRef) throw new Error('Missing replacement provider reference');
        expect(physical.state).toBe('running');
        expect(physical.providerRef).not.toBe(firstRef);
        expect(attachment.kilo.token).not.toBe(firstGrant.kilo.alias);
        expect(attachment.git.token).not.toBe(firstGrant.scm.alias);
        const grants = await storedGrants(control);
        const [replacementGrant] = grants;
        expect(grants).toHaveLength(1);
        expect(replacementGrant.members).toEqual([
          { sessionId: registration.identity.sessionId, kiloSessionId: ROOT_ID },
        ]);
        await control.attachSession(attachInput(registration, attachment));
        const launch = containers.launches[completion === 'startup-failed' ? 1 : 0];
        expect(launch.physical).toEqual(physical);
        expect(launch.env.PROVIDER_INSTANCE_ID).toBe(physical.providerRef);
        currentSocket = await connect(launch.env.SANDBOX_CONTROL_CREDENTIAL, sandboxId);
        await completeHello(currentSocket, `hello-current-${completion}`, {
          providerInstanceId: physical.providerRef,
        });
        signalWrapperReady(currentSocket);
        await vi.waitFor(async () => {
          await expect(control.getStatus()).resolves.toMatchObject({
            physical: 'running',
            connection: 'ready',
          });
        });

        if (completion === 'reject')
          deferred.reject(new Error('Deferred Cloudflare creation failed'));
        else if (completion === 'startup-failed')
          launchDeferred.reject(new Error('Deferred wrapper launch failed'));
        else deferred.resolve({ providerRef: firstRef });
        const outcome = await pending;
        expect(await control.getPhysicalRecord()).toEqual(physical);
        await expect(control.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'ready',
        });
        expect(currentSocket.readyState).toBe(1);
        expect(containers.running.has(launch.containerId ?? '')).toBe(true);
        if (!native) throw new Error('Missing current native adapter');
        await expect(
          native.observe(physical.providerRef, physical.createIntent)
        ).resolves.toMatchObject({ status: 'active' });
        expect(await storedGrants(control)).toEqual(grants);
        if (outcome.type === 'resolved' && outcome.status.attachment) {
          expect(outcome.status.attachment.kilo).toEqual(attachment.kilo);
          expect(outcome.status.attachment.git).toEqual(attachment.git);
        }
        expect(JSON.stringify(outcome)).not.toContain(firstGrant.kilo.alias);
        expect(JSON.stringify(outcome)).not.toContain(firstGrant.scm.alias);
        expectSanitized(outcome, broker);
        const request = {
          outboundContainerId: replacementGrant.outboundContainerId ?? '',
          url: `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`,
          method: 'GET',
        };
        await expect(
          control.resolveCredential({ ...request, credential: firstGrant.kilo.alias })
        ).resolves.toBeNull();
        await expect(
          control.resolveCredential({ ...request, credential: attachment.kilo.token })
        ).resolves.toEqual({
          credential:
            replacementGrant.kilo.capabilities[registration.identity.sessionId].credential,
          organizationId: registration.identity.orgId,
        });
        expect(await control.listRoutes()).toEqual([
          expect.objectContaining(attachInput(registration, attachment)),
        ]);
      } finally {
        deferred.resolve(firstResult ?? { unresolved: true });
        launchDeferred.resolve();
        await pending;
        currentSocket?.close();
      }
    }
  );

  it('cleans up a Cloudflare instance without launching if native outbound containment cannot be installed', async () => {
    const { control, registration, containers, broker } = await credentialFixture();
    containers.setOutboundFailure();
    await expect(
      control.ensureReady({ ...credentialInput(registration), allowCreate: true })
    ).resolves.toMatchObject({ physical: 'failed' });
    expect(containers.launches).toEqual([]);
    const physical = await control.getPhysicalRecord();
    const nativeId = decodeCloudflareProviderRef(physical.providerRef)?.sandboxId;
    expect(nativeId).toBe(physical.createIntent?.allocationName);
    expect(Array.from(broker.kiloSubjects.values())[0]?.outboundContainerId).toBe(
      `contained:${nativeId}`
    );
    await control.recordStopAttempt();
    expect(containers.destroyed).toEqual([`contained:${nativeId}`]);
    await finishFailedCreation(control);
    expect(await storedGrants(control)).toEqual([]);
    await expect(control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopped',
      providerRef: null,
    });
  });

  it.each([
    ['usr', 'standard', 'contained'],
    ['istd', 'standard', 'contained'],
    ['ses', 'small', 'contained-small'],
    ['crv', 'review', 'contained-review'],
  ] as const)(
    'rejects and cleans legacy %s instances in their own native namespace',
    async (prefix, rawNamespace, containedNamespace) => {
      for (const marker of ['raw', 'unmarked', 'old-marker'] as const) {
        const fixture = await credentialFixture(
          'cloudflare',
          `${prefix}-${crypto.randomUUID().replaceAll('-', '')}`
        );
        const { control, registration, containers, sandboxId } = fixture;
        const providerRef = marker === 'raw' ? sandboxId : cloudflareRef(sandboxId);
        const physical: PhysicalRecord = {
          state: 'running',
          providerRef,
          resumable: false,
          createIntent: null,
          stopTombstone: null,
          ...(marker === 'old-marker'
            ? { containment: { kilocode: true, github: true, providerRef } }
            : {}),
        };
        const originalContainer = `${marker === 'raw' ? rawNamespace : containedNamespace}:${sandboxId}`;
        const otherContainer = `${marker === 'raw' ? containedNamespace : rawNamespace}:${sandboxId}`;
        containers.running.add(originalContainer);
        containers.running.add(otherContainer);
        const credential = generateSandboxCredential();
        await runInDurableObject(control, async (instance, state) => {
          await state.storage.put('physical_record', physical);
          await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
        });
        const ws = await connect(credential, sandboxId);
        await rejectHello(ws, `hello-legacy-${prefix}-${marker}`, providerRef);
        await expect(control.getPhysicalRecord()).resolves.toEqual(physical);
        await expect(
          control.ensureReady({ ...credentialInput(registration), allowCreate: true })
        ).resolves.toMatchObject({ physical: 'stopped' });
        expect(containers.destroyed).toEqual([originalContainer]);
        expect(containers.running.has(originalContainer)).toBe(false);
        expect(containers.running.has(otherContainer)).toBe(true);
        expect(containers.launches).toEqual([]);
        expect(await storedGrants(control)).toEqual([]);
      }
    }
  );

  it.each(['cloudflare', 'vercel'] as const)(
    'preserves explicit profile GitHub overrides on %s without changing managed git auth',
    async provider => {
      const { control, registration, session, broker } = await credentialFixture(provider);
      let originalAlias: string | undefined;
      const profileOverrides: Record<string, string>[] = [
        { GH_TOKEN: 'profile-gh-token', GITHUB_TOKEN: 'profile-github-token' },
        { GITHUB_TOKEN: 'profile-github-token' },
      ];
      for (const envVars of profileOverrides) {
        await updateCredentialMetadata(session, metadata => ({
          ...metadata,
          profile: { ...metadata.profile, envVars },
        }));
        const payload = await readyAttachment(control, credentialInput(registration));
        expect(payload.env?.GH_TOKEN).toBe(envVars.GH_TOKEN ?? envVars.GITHUB_TOKEN);
        expect(payload.env?.GITHUB_TOKEN).toBe(envVars.GITHUB_TOKEN);
        expect(payload.git?.token).not.toBe(payload.env?.GH_TOKEN);
        expect(payload.git?.token).toMatch(/^kcp1\./);
        if (originalAlias) expect(payload.git?.token).toBe(originalAlias);
        originalAlias = payload.git?.token;
        expectSanitized(payload, broker);
      }
    }
  );

  it.each([
    'missing-kilo-token',
    'capability-kilo-token',
    'custom-github-token',
    'custom-git-token',
    'embedded-git-credential',
    'devcontainer',
    'vercel-gitlab',
  ] as const)(
    'rejects unsupported %s credentials before any provider create',
    async configuration => {
      const provider = configuration === 'vercel-gitlab' ? 'vercel' : 'cloudflare';
      const { control, registration, session, broker, containers, vercel } =
        await credentialFixture(provider);
      await updateCredentialMetadata(session, metadata => {
        if (configuration === 'missing-kilo-token' || configuration === 'capability-kilo-token') {
          return {
            ...metadata,
            auth: {
              ...metadata.auth,
              kilocodeToken:
                configuration === 'missing-kilo-token' ? undefined : 'kka1.existing-capability',
            },
          };
        }
        if (configuration === 'custom-github-token') {
          return {
            ...metadata,
            repository: { type: 'github', repo: 'acme/repo', token: GITHUB_TOKEN },
          };
        }
        if (configuration === 'custom-git-token' || configuration === 'embedded-git-credential') {
          const repositoryUrl = new URL('https://git.example.com/acme/repo.git');
          if (configuration === 'embedded-git-credential') {
            repositoryUrl.username = 'fake-user';
            repositoryUrl.password = 'fake-password';
          }
          return {
            ...metadata,
            repository: {
              type: 'git',
              url: repositoryUrl.href,
              ...(configuration === 'custom-git-token' ? { token: 'fixture-custom-token' } : {}),
            },
          };
        }
        if (configuration === 'devcontainer') {
          return { ...metadata, workspace: { ...metadata.workspace, devcontainerRequested: true } };
        }
        return {
          ...metadata,
          repository: { type: 'gitlab', url: 'https://gitlab.example.com/acme/repo.git' },
        };
      });
      await expect(async () =>
        control.prepareSessionCredentials(credentialInput(registration))
      ).rejects.toThrow('Sandbox credential containment is unavailable');
      await expect(async () =>
        control.ensureReady({ ...credentialInput(registration), allowCreate: true })
      ).rejects.toThrow('Invalid contained worktree credentials');
      expect(await storedGrants(control)).toEqual([]);
      expect(containers.launches).toEqual([]);
      expect(vercel.runtime.creates).toBe(0);
      expect(broker.kiloSubjects.size).toBe(0);
      expect(broker.githubSubjects.size).toBe(0);
    }
  );
});

describe('SandboxControl recovery watchdogs', () => {
  it('repairs a partially persisted stop and its system alarm after a Durable Object reset', async () => {
    const id = 'usr-partial-stop';
    let control = env.SANDBOX_CONTROL.getByName(id);
    const { provider, allocations } = await installProvider(control, cloudflareRef(id));
    await control.initializeOwner('owner_partial_stop');
    await control.claimCreate('intent_partial_stop');
    const running = await control.confirmInstance(cloudflareRef(id));
    const wrapperInstanceId = crypto.randomUUID();
    const partial = beginStop(running, 'preparation_interrupted', Date.now(), wrapperInstanceId);
    await runInDurableObject(control, async (_instance, state) => {
      await savePhysicalRecord(state.storage, partial);
      await saveDeadlines(state.storage, {});
      await state.storage.put('wrapper_ready_at', Date.now());
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });

    await abortAllDurableObjects();
    control = env.SANDBOX_CONTROL.getByName(id);
    const repairedAt = await runInDurableObject(control, async (instance, state) => {
      await expect(instance.getPhysicalRecord()).resolves.toEqual(partial);
      const deadlines = await loadDeadlines(state.storage);
      expect(deadlines).toEqual({ stopAttempt: expect.any(Number) });
      expect(await state.storage.getAlarm()).toBe(deadlines.stopAttempt);
      expect(await state.storage.get('wrapper_ready_at')).toBeUndefined();
      return deadlines.stopAttempt;
    });
    await expect(
      control.quarantineRuntime({
        ownerId: 'owner_partial_stop',
        sessionId: 'workspace_partial_stop',
        wrapperInstanceId,
        reason: 'preparation_interrupted',
      })
    ).resolves.toEqual({ quarantined: true });
    await runInDurableObject(control, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(repairedAt);
    });
    expect(provider.stop).not.toHaveBeenCalled();

    await fireControlDeadline(control, 'stopAttempt');
    await expect(control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopped',
      providerRef: null,
      stopTombstone: null,
    });
    await runInDurableObject(control, async (_instance, state) => {
      expect(await loadDeadlines(state.storage)).toEqual({});
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(allocations.size).toBe(0);
    expect(provider.stop).toHaveBeenCalledExactlyOnceWith(cloudflareRef(id), partial.createIntent);
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.launch).not.toHaveBeenCalled();
  });

  describe('SandboxControl failed-instance reconciliation', () => {
    it('retries exact Vercel cleanup without reviving a failed instance', async () => {
      const requestedSandboxId = 'sbx__containment_reconciliation_retry';
      const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
      await runInDurableObject(stub, async (instance, state) => {
        const providerRef = encodeVercelProviderRef({
          sandboxName: requestedSandboxId,
          sessionId: 'vsess_retry',
        });
        const stoppedRefs: Array<string | null> = [];
        const observedRefs: Array<string | null> = [];
        const provider = fakeProvider({
          async stop(ref) {
            stoppedRefs.push(ref);
            return stoppedRefs.length === 1 ? 'retryable' : 'terminal';
          },
          async observe(ref) {
            observedRefs.push(ref);
            return { status: 'active' };
          },
        });
        await seedRunningVercel(instance, state, requestedSandboxId, provider, {
          physical: containedRunningRecord(providerRef),
        });
        await instance.markFailed();
        await state.storage.put('deadlines', { stopAttempt: Date.now() - 1 });
        const startedAt = Date.now();

        await instance.alarm();
        await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
          state: 'stopping',
          providerRef,
          stopTombstone: { reason: 'environment_failed', attempts: 1 },
        });
        expect(stoppedRefs).toEqual([providerRef]);
        expect(observedRefs).toEqual([providerRef]);
        const rearmed = await state.storage.get<DeadlineTable>('deadlines');
        expect(rearmed?.stopAttempt).toBeGreaterThanOrEqual(
          startedAt + DEADLINE_MS.stopAttemptLadder[0]
        );
        expect(await state.storage.getAlarm()).toBe(rearmed?.stopAttempt);

        await state.storage.put('deadlines', { stopAttempt: Date.now() - 1 });
        await instance.alarm();
        await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
          state: 'stopped',
          providerRef: null,
        });
        expect(stoppedRefs).toEqual([providerRef, providerRef]);
        expect(observedRefs).toEqual([providerRef]);
        expect(
          (await state.storage.get<DeadlineTable>('deadlines'))?.reconciliation
        ).toBeUndefined();
      });
    });
  });

  it('rolls back physical state, authority, deadlines, and the real alarm when retirement fails', async () => {
    const fixture = {
      sandboxId: 'usr-a010',
      ownerId: 'owner_rollback_stop',
      sessionId: GRANT_SESSION_ID,
      wrapperInstanceId: crypto.randomUUID(),
    } as const satisfies TerminalRuntimeFixture;
    const { control, socket, provider } = await initializeTerminalRuntime(fixture);
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      captureAndAcceptControlRequests(socket);
      await runInDurableObject(control, async (instance, state) => {
        const keys = [
          'physical_record',
          'wrapper_credential_hash',
          'active_wrapper_runtime',
          'wrapper_ready_at',
          'deadlines',
          'transition_log',
        ];
        const before = await state.storage.get(keys);
        const alarmAt = await state.storage.getAlarm();
        const setAlarm = state.storage.setAlarm.bind(state.storage);
        const failure = vi.spyOn(state.storage, 'setAlarm').mockImplementationOnce(async at => {
          await setAlarm(at);
          throw new Error('injected alarm commit failure');
        });
        try {
          await expect(instance.beginStop('rollback_test')).rejects.toThrow(
            'injected alarm commit failure'
          );
        } finally {
          failure.mockRestore();
        }
        expect(await state.storage.get(keys)).toEqual(before);
        expect(await state.storage.getAlarm()).toBe(alarmAt);
        await expect(instance.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: fixture.wrapperInstanceId,
        });
      });
      await expect(
        control.request({
          operation: 'session.sync',
          session: {
            sessionId: fixture.sessionId,
            kiloSessionId: ROOT_ID,
            directory: '/workspace/terminal',
          },
          payload: {},
        })
      ).resolves.toMatchObject({ ok: true, result: { status: { type: 'busy' } } });
      expect(provider.stop).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
    } finally {
      socket.close();
    }
  });

  it('retires a credential-rotated runtime when its replacement readiness alarm expires', async () => {
    const fixture = {
      sandboxId: 'usr-a011',
      ownerId: 'owner_rotation_watchdog',
      sessionId: GRANT_SESSION_ID,
      wrapperInstanceId: crypto.randomUUID(),
    } as const satisfies TerminalRuntimeFixture;
    const { control, socket, provider, allocations } = await initializeTerminalRuntime(fixture);
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      const rotatedAt = Date.now();
      await control.setWrapperCredentialHash(
        await hashSandboxCredential(generateSandboxCredential())
      );
      await runInDurableObject(control, async (instance, state) => {
        const deadlines = await loadDeadlines(state.storage);
        expect(deadlines).toEqual({ wrapperReadiness: expect.any(Number) });
        expect(deadlines.wrapperReadiness).toBeGreaterThanOrEqual(
          rotatedAt + DEADLINE_MS.wrapperReadiness
        );
        expect(await state.storage.getAlarm()).toBe(deadlines.wrapperReadiness);
        expect(await state.storage.get('active_wrapper_runtime')).toBeUndefined();
        await expect(instance.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'disconnected',
        });
      });
      await fireControlDeadline(control, 'wrapperReadiness');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'failed',
        stopTombstone: { reason: 'environment_failed', attempts: 0 },
      });
      await fireControlDeadline(control, 'stopAttempt');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({ state: 'stopped' });
      expect(allocations.size).toBe(0);
      expect(provider.stop).toHaveBeenCalledTimes(1);
      expect(provider.create).not.toHaveBeenCalled();
    } finally {
      socket.close();
    }
  });

  it('continues native reaping beyond one hour while the first underlying stop remains unresolved', async () => {
    const id = `usr-${crypto.randomUUID().replaceAll('-', '')}`;
    const control = env.SANDBOX_CONTROL.getByName(id);
    const { provider, allocations } = await installProvider(control, cloudflareRef(id));
    await registerCredentialSession({
      identity: { sessionId: GRANT_SESSION_ID, userId: 'owner_native_reaping' },
      auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
      agent: {},
      workspace: { sandboxId: id as SandboxId, workspacePath: '/workspace/reaping' },
    });
    const firstNativeCall = Promise.withResolvers<void>();
    const nativeEntered = Promise.withResolvers<void>();
    let firstNativeSettled = false;
    let nativeAvailable = false;
    const native = {
      isContainerRunning: vi.fn(async () => allocations.has(cloudflareRef(id))),
      forceDestroyForControlPlane: vi.fn(async () => {
        if (!nativeAvailable) throw new Error('native stop temporarily unavailable');
        allocations.delete(cloudflareRef(id));
      }),
      destroy: vi.fn(async () => {
        throw new Error('Legacy SDK destruction must not be used');
      }),
    };
    native.forceDestroyForControlPlane.mockImplementationOnce(async () => {
      nativeEntered.resolve();
      await firstNativeCall.promise;
      firstNativeSettled = true;
    });
    const sandbox: Partial<CloudflareSandboxHandle> = native;
    const adapter = createCloudflareProviderAdapter({
      sandboxId: id,
      getSandbox: () => sandbox as CloudflareSandboxHandle,
      destroy: async allocationId => {
        expect(allocationId).toBe(id);
        await forceDestroyControlPlaneSandbox(native);
      },
    });
    provider.stop.mockImplementation((ref, intent) => adapter.stop(ref, intent));
    provider.observe.mockImplementation((ref, intent) => adapter.observe(ref, intent));
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      await control.claimCreate('intent_native_reaping');
      await control.confirmInstance(cloudflareRef(id));
      await control.beginStop('native_stop_unavailable');
      await runInDurableObject(control, async instance => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const first = instance.recordStopAttempt();
          await nativeEntered.promise;
          clock.mockReturnValue(startedAt + DEADLINE_MS.stopAttempt);
          vi.advanceTimersByTime(DEADLINE_MS.stopAttempt);
          await expect(first).resolves.toMatchObject({
            state: 'stopping',
            stopTombstone: { attempts: 1 },
          });
        } finally {
          vi.useRealTimers();
        }
      });
      expect(firstNativeSettled).toBe(false);
      expect(native.forceDestroyForControlPlane).toHaveBeenCalledTimes(1);
      for (let attempt = 2; attempt <= DEADLINE_MS.stopAttemptLadder.length; attempt++) {
        await fireControlDeadline(control, 'stopAttempt');
        expect(native.forceDestroyForControlPlane).toHaveBeenCalledTimes(attempt);
      }
      const exhausted = await control.getPhysicalRecord();
      expect(exhausted).toMatchObject({
        state: 'unknown',
        providerRef: cloudflareRef(id),
        stopTombstone: { createdAt: startedAt, attempts: 5 },
      });
      clock.mockReturnValue(startedAt + DEADLINE_MS.reconciliationWindow + 1);
      const nextPassAt = Date.now() + DEADLINE_MS.reconciliation;
      provider.observe.mockImplementationOnce(async (ref, intent) => {
        await runInDurableObject(control, async (_instance, state) => {
          expect(await loadDeadlines(state.storage)).toEqual({ reconciliation: nextPassAt });
          expect(await state.storage.getAlarm()).toBe(nextPassAt);
        });
        return adapter.observe(ref, intent);
      });
      await expect(runDurableObjectAlarm(control)).resolves.toBe(true);
      expect(native.forceDestroyForControlPlane).toHaveBeenCalledTimes(6);
      expect(firstNativeSettled).toBe(false);
      await expect(control.getPhysicalRecord()).resolves.toEqual(exhausted);
      await expect(
        control.ensureReady({
          ownerId: 'owner_native_reaping',
          sessionId: GRANT_SESSION_ID,
          allowCreate: true,
        })
      ).resolves.toMatchObject({ physical: 'unknown' });
      await runInDurableObject(control, async (_instance, state) => {
        expect(await loadDeadlines(state.storage)).toEqual({ reconciliation: nextPassAt });
        expect(await state.storage.getAlarm()).toBe(nextPassAt);
      });
      expect(native.forceDestroyForControlPlane).toHaveBeenCalledTimes(6);
      expect(allocations).toEqual(new Set([cloudflareRef(id)]));

      nativeAvailable = true;
      clock.mockReturnValue(nextPassAt);
      await expect(runDurableObjectAlarm(control)).resolves.toBe(true);
      expect(native.forceDestroyForControlPlane).toHaveBeenCalledTimes(7);
      expect(firstNativeSettled).toBe(false);
      expect(native.destroy).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.launch).not.toHaveBeenCalled();
      expect(allocations.size).toBe(0);
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
        stopTombstone: null,
      });
      await runInDurableObject(control, async (_instance, state) => {
        expect(await loadDeadlines(state.storage)).toEqual({});
        expect(await state.storage.getAlarm()).toBeNull();
      });
    } finally {
      firstNativeCall.resolve();
      vi.useRealTimers();
      clock.mockRestore();
    }
  });

  it.each(['disconnected', 'ready'] as const)(
    'retains cleanup for an uncertain %s runtime and restores readiness watchdogs only on its replacement',
    async connection => {
      const id = crypto.randomUUID().replaceAll('-', '');
      const fixture = {
        sandboxId: `usr-${id}`,
        ownerId: 'owner_recovery_watchdog',
        sessionId: `workspace_${crypto.randomUUID()}`,
        wrapperInstanceId: crypto.randomUUID(),
      } as const satisfies TerminalRuntimeFixture;
      const credential = generateSandboxCredential();
      await registerCredentialSession({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
        agent: {},
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
      });
      await seedCredential(credential, fixture.sandboxId);
      const control = env.SANDBOX_CONTROL.getByName(fixture.sandboxId);
      const { provider } = await installProvider(control, cloudflareRef(fixture.sandboxId));
      await control.confirmInstance(cloudflareRef(fixture.sandboxId));
      let socket: WebSocket | undefined;
      let replacement: WebSocket | undefined;
      try {
        if (connection === 'ready') {
          socket = await connect(credential, fixture.sandboxId);
          await completeHello(socket, 'hello_watchdog_original', {
            providerInstanceId: cloudflareRef(fixture.sandboxId),
            wrapperInstanceId: fixture.wrapperInstanceId,
          });
          signalWrapperReady(socket);
          await waitForWrapperReady(fixture);
        }
        await runInDurableObject(control, async (instance, state) => {
          const uncertain = await instance.observeProvider('unknown');
          expect(uncertain).toMatchObject({
            state: 'unknown',
            providerRef: cloudflareRef(fixture.sandboxId),
            stopTombstone: { reason: 'provider_unknown' },
          });
          const deadlines = await loadDeadlines(state.storage);
          expect(deadlines.wrapperReadiness).toBeUndefined();
          expect(deadlines.heartbeatExpiry).toBeUndefined();
          expect(deadlines.stopAttempt).toEqual(expect.any(Number));
          expect(await state.storage.getAlarm()).toBe(deadlines.stopAttempt);
          await expect(instance.observeProvider('active')).resolves.toEqual(uncertain);
          await expect(instance.observeProvider('active')).resolves.toEqual(uncertain);
          expect((await loadDeadlines(state.storage)).stopAttempt).toBe(deadlines.stopAttempt);
        });
        await expect(
          control.ensureReady({
            ownerId: fixture.ownerId,
            sessionId: fixture.sessionId,
            allowCreate: false,
          })
        ).resolves.toMatchObject({ physical: 'unknown', connection: 'disconnected' });
        expect(provider.create).not.toHaveBeenCalled();
        await expect(control.observeProvider('terminal')).resolves.toMatchObject({
          state: 'stopped',
          providerRef: null,
        });
        await control.ensureReady({
          ownerId: fixture.ownerId,
          sessionId: fixture.sessionId,
          allowCreate: false,
        });
        expect(provider.create).not.toHaveBeenCalled();
        await control.ensureReady({
          ownerId: fixture.ownerId,
          sessionId: fixture.sessionId,
          allowCreate: true,
        });
        const launch = provider.launch.mock.calls[0];
        if (!launch) throw new Error('Expected replacement wrapper launch');
        expect(launch[0]).not.toBe(cloudflareRef(fixture.sandboxId));
        replacement = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
        const recoveredAt = Date.now();
        const nextFixture = { ...fixture, wrapperInstanceId: crypto.randomUUID() };
        await completeHello(replacement, 'hello_watchdog_replacement', {
          providerInstanceId: launch[0],
          wrapperInstanceId: nextFixture.wrapperInstanceId,
        });
        await runInDurableObject(control, async (_instance, state) => {
          const deadlines = await loadDeadlines(state.storage);
          expect(deadlines.wrapperReadiness).toBeGreaterThanOrEqual(
            recoveredAt + DEADLINE_MS.wrapperReadiness
          );
          expect(deadlines.heartbeatExpiry).toBeUndefined();
          expect(await state.storage.getAlarm()).toBe(deadlines.wrapperReadiness);
        });
        signalWrapperReady(replacement);
        await waitForWrapperReady(nextFixture);
        await runInDurableObject(control, async (instance, state) => {
          const deadlines = await loadDeadlines(state.storage);
          expect(deadlines.heartbeatExpiry).toBeGreaterThanOrEqual(
            recoveredAt + DEADLINE_MS.heartbeatExpiry
          );
          expect(deadlines.wrapperReadiness).toBeUndefined();
          expect(await state.storage.getAlarm()).toBe(deadlines.heartbeatExpiry);
          await instance.observeProvider('active');
          expect((await loadDeadlines(state.storage)).heartbeatExpiry).toBe(
            deadlines.heartbeatExpiry
          );
        });
        expect(provider.create).toHaveBeenCalledTimes(1);
      } finally {
        socket?.close();
        replacement?.close();
      }
    }
  );
});

describe('SandboxControl acquisition receipts', () => {
  it('does not allocate twice after a lost acquisition response, reaping, and reset', async () => {
    const sandboxId = `usr-${crypto.randomUUID().replaceAll('-', '')}` as const;
    let control = env.SANDBOX_CONTROL.getByName(sandboxId);
    const { provider, allocations } = await installProvider(control);
    let responseHeld = false;
    const releaseResponse = Promise.withResolvers<void>();
    const acquisition = {
      id: crypto.randomUUID(),
      deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
    };
    const input = { ownerId: 'owner_lost_acquisition', sessionId: GRANT_SESSION_ID, acquisition };
    await registerCredentialSession({
      identity: { sessionId: input.sessionId, userId: input.ownerId },
      auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
      agent: {},
      workspace: { sandboxId, workspacePath: '/workspace/receipts' },
    });
    const responseSpy = await runInDurableObject(control, instance => {
      const prototype = Object.getPrototypeOf(instance) as typeof instance;
      const ensureReady = instance.ensureReady.bind(instance);
      return vi.spyOn(prototype, 'ensureReady').mockImplementationOnce(async request => {
        const result = await ensureReady(request);
        responseHeld = true;
        await releaseResponse.promise;
        return result;
      });
    });
    const lostResponse = control.ensureReady(input).then(
      () => null,
      (error: unknown) => error
    );
    try {
      await vi.waitFor(() => expect(responseHeld).toBe(true));
      const physical = await control.getPhysicalRecord();
      expect(physical).toMatchObject({ state: 'running', providerRef: expect.any(String) });
      const receipts = await runInDurableObject(control, (_instance, state) =>
        state.storage.get('acquisition_receipts')
      );
      expect(receipts).toEqual([
        { ...acquisition, allocation: { kind: 'intent', id: physical.createIntent?.intentId } },
      ]);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.launch).toHaveBeenCalledTimes(1);
      expect(allocations.size).toBe(1);
      const launch = provider.launch.mock.calls[0];
      if (!launch) throw new Error('Expected acquisition wrapper launch');
      const wrapper = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, sandboxId);
      await completeHello(wrapper, 'hello-lost-acquisition', {
        providerInstanceId: launch[0],
        wrapperInstanceId: crypto.randomUUID(),
      });
      await control.beginStop('lost_acquisition_response');
      await fireControlDeadline(control, 'stopAttempt');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
        createIntent: null,
      });
      expect(allocations.size).toBe(0);

      await expect(
        runInDurableObject(control, (_instance, state) => state.abort('acquisition response lost'))
      ).rejects.toThrow('acquisition response lost');
      expect(await lostResponse).toMatchObject({ message: 'acquisition response lost' });
      responseSpy.mockRestore();
      releaseResponse.resolve();
      control = env.SANDBOX_CONTROL.getByName(sandboxId);
      await runInDurableObject(control, async (_instance, state) => {
        expect(await state.storage.get('acquisition_receipts')).toEqual(receipts);
        expect(await state.storage.getAlarm()).toBeNull();
      });
      await expect(
        Promise.resolve(control.ensureReady({ ...input, allowCreate: true }))
      ).rejects.toThrow('Sandbox acquisition no longer owns this allocation');
      await expect(
        Promise.resolve(
          control.ensureReady({
            ...input,
            acquisition: { ...acquisition, deadlineAt: acquisition.deadlineAt + 1 },
          })
        )
      ).rejects.toThrow('Sandbox acquisition deadline changed');
      await expect(
        Promise.resolve(
          control.ensureReady({
            ...input,
            acquisition: { id: crypto.randomUUID(), deadlineAt: Date.now() - 1 },
          })
        )
      ).rejects.toThrow('Sandbox acquisition expired');
      await expect(
        control.ensureReady({
          ownerId: input.ownerId,
          sessionId: input.sessionId,
          allowCreate: false,
        })
      ).resolves.toMatchObject({
        physical: 'stopped',
      });
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.launch).toHaveBeenCalledTimes(1);
      expect(allocations.size).toBe(0);

      const fresh = {
        id: crypto.randomUUID(),
        deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
      };
      await expect(control.ensureReady({ ...input, acquisition: fresh })).resolves.toMatchObject({
        physical: 'running',
      });
      const replacement = await control.getPhysicalRecord();
      expect(replacement.providerRef).not.toBe(physical.providerRef);
      expect(allocations).toEqual(new Set([replacement.providerRef]));
      expect(provider.create).toHaveBeenCalledTimes(2);
      expect(provider.launch).toHaveBeenCalledTimes(2);
      await expect(Promise.resolve(control.ensureReady(input))).rejects.toThrow(
        'Sandbox acquisition no longer owns this allocation'
      );
      expect(provider.ensureBillingAdmission).not.toHaveBeenCalled();
      await runInDurableObject(control, async (_instance, state) => {
        expect(await state.storage.get('acquisition_receipts')).toEqual([
          ...(receipts as unknown[]),
          { ...fresh, allocation: { kind: 'intent', id: replacement.createIntent?.intentId } },
        ]);
      });
    } finally {
      releaseResponse.resolve();
    }
  });
});

describe('SandboxControl failed-instance reconciliation', () => {
  it('does not stop or revive a failed Vercel instance with a malformed reference', async () => {
    const requestedSandboxId = 'sbx__containment_reconciliation_malformed';
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      const nativeCalls: string[] = [];
      const provider = unresolvableVercelProvider(requestedSandboxId, nativeCalls);
      await seedRunningVercel(instance, state, requestedSandboxId, provider, {
        physical: {
          state: 'failed',
          providerRef: requestedSandboxId,
          createIntent: null,
          stopTombstone: null,
          resumable: false,
        },
      });
      await state.storage.put('deadlines', { reconciliation: Date.now() - 1 });

      await instance.alarm();
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'unknown',
        providerRef: requestedSandboxId,
        stopTombstone: { reason: 'provider_unknown', attempts: 0 },
      });
      expect(nativeCalls).toEqual([]);
      expect((await state.storage.get<DeadlineTable>('deadlines'))?.reconciliation).toBeGreaterThan(
        Date.now()
      );
      await state.storage.put('deadlines', { stopAttempt: Date.now() - 1 });
      await instance.alarm();
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopping',
        providerRef: requestedSandboxId,
        stopTombstone: { attempts: 1 },
      });
      expect(nativeCalls).toEqual([]);
    });
  });

  it('reclaims a failed Cloudflare instance without reviving it', async () => {
    const requestedSandboxId = 'sbx__containment_reconciliation_cloudflare';
    const stub = env.SANDBOX_CONTROL.getByName(requestedSandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      const providerRef = cloudflareRef(requestedSandboxId);
      await seedGrant(instance, state);
      const stoppedRefs: Array<string | null> = [];
      const observedRefs: Array<string | null> = [];
      const provider = fakeProvider({
        async stop(ref) {
          stoppedRefs.push(ref);
          return 'terminal';
        },
        async observe(ref) {
          observedRefs.push(ref);
          return { status: 'active' };
        },
      });
      await seedRunningVercel(instance, state, requestedSandboxId, provider, {
        providerKind: 'cloudflare',
        physical: {
          state: 'failed',
          providerRef,
          createIntent: null,
          stopTombstone: null,
          resumable: false,
        },
      });
      await state.storage.put('deadlines', { reconciliation: Date.now() - 1 });

      await instance.alarm();
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'unknown',
        providerRef,
        stopTombstone: { attempts: 0 },
      });
      expect(observedRefs).toEqual([providerRef]);
      expect(stoppedRefs).toEqual([]);
      await state.storage.put('deadlines', { stopAttempt: Date.now() - 1 });
      await instance.alarm();
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
      });
      expect(observedRefs).toEqual([providerRef]);
      expect(stoppedRefs).toEqual([providerRef]);
      expect(await loadSessionCredentialGrants(state.storage)).toEqual([]);
    });
  });
});

describe('SandboxControl durable remainder', () => {
  it('persists create intent before an instance ref exists', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_create_intent');
    await runInDurableObject(stub, async instance => {
      const record = await instance.claimCreate('intent_1');
      expect(record.state).toBe('creating');
      expect(record.createIntent?.intentId).toBe('intent_1');
      expect(record.providerRef).toBeNull();
      await expect(instance.getPhysicalRecord()).resolves.toEqual(record);
      await expect(instance.getStatus()).resolves.toMatchObject({
        reported: 'booting',
        physical: 'creating',
      });
    });
  });

  it('attaches a session route and rejects owner or directory conflicts', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_routes');
    await runInDurableObject(stub, async (instance, state) => {
      await instance.initializeOwner('owner_1');
      await instance.claimCreate(
        'intent_routes',
        false,
        undefined,
        WORKTREE_CREDENTIAL_CONTAINMENT
      );
      const route = await attachGrantedSession(instance, state, {
        sessionId: GRANT_SESSION_ID,
        kiloSessionId: ROOT_ID,
        directory: '/workspace/a',
        ownerId: 'owner_1',
      });
      expect(route.sessionId).toBe(GRANT_SESSION_ID);
      await expect(
        instance.attachSession({
          sessionId: GRANT_SESSION_ID,
          kiloSessionId: ROOT_ID,
          directory: '/workspace/a',
          ownerId: 'owner_1',
        })
      ).resolves.toMatchObject({ sessionId: GRANT_SESSION_ID });
      await expect(
        attachGrantedSession(instance, state, {
          sessionId: SECOND_GRANT_SESSION_ID,
          kiloSessionId: SECOND_ROOT_ID,
          directory: '/workspace/a',
          ownerId: 'owner_1',
        })
      ).rejects.toThrow('Directory already attached');
      await expect(
        instance.attachSession({
          sessionId: GRANT_SESSION_ID,
          kiloSessionId: ROOT_ID,
          directory: '/workspace/a',
          ownerId: 'owner_other',
        })
      ).rejects.toThrow('Sandbox owner mismatch');
    });
  });

  it('rearms idle stop when its final active session is detached', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_detach_last_active');
    await runInDurableObject(stub, async (instance, state) => {
      await instance.initializeOwner('owner_1');
      await seedRunningCloudflare(instance);
      await attachGrantedSession(instance, state, {
        sessionId: GRANT_SESSION_ID,
        kiloSessionId: ROOT_ID,
        directory: '/workspace/last-active',
        ownerId: 'owner_1',
      });
      const routes = await loadRouteTable(state.storage);
      applyReportedSessionState(routes, ROOT_ID, { state: 'active', idleForMs: 0 }, Date.now());
      await saveRouteTable(state.storage, routes);
      expect((await loadDeadlines(state.storage)).idleStop).toBeUndefined();

      const detachedAt = Date.now();
      await expect(instance.detachSession(GRANT_SESSION_ID)).resolves.toEqual({
        existed: true,
      });
      const idleStop = (await loadDeadlines(state.storage)).idleStop;
      expect(idleStop).toBeGreaterThanOrEqual(detachedAt + DEADLINE_MS.idleStop);
      await expect(instance.listRoutes()).resolves.toEqual([]);
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({ state: 'running' });

      await expect(instance.detachSession(GRANT_SESSION_ID)).resolves.toEqual({
        existed: false,
      });
      expect((await loadDeadlines(state.storage)).idleStop).toBe(idleStop);
    });
  });

  it('projects shutting-down after beginStop and retains the tombstone without a ref', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_stop_tombstone');
    await runInDurableObject(stub, async instance => {
      await instance.claimCreate('intent_stop');
      const stopping = await instance.beginStop('idle');
      expect(stopping.state).toBe('stopping');
      expect(stopping.providerRef).toBeNull();
      expect(stopping.createIntent?.intentId).toBe('intent_stop');
      expect(stopping.stopTombstone?.reason).toBe('idle');
      await expect(instance.getStatus()).resolves.toMatchObject({
        reported: 'shutting-down',
        physical: 'stopping',
      });
    });
  });

  it('arms idle stop on ready, cancels it for active work, and rearms it when work becomes idle', async () => {
    const sandboxId = 'sbx__control_heartbeat_idle_stop';
    const credential = generateSandboxCredential();
    const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.initializeOwner('owner_1');
      await seedRunningCloudflare(instance);
      await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
      await attachGrantedSession(instance, state, {
        sessionId: GRANT_SESSION_ID,
        kiloSessionId: ROOT_ID,
        directory: '/workspace/a',
        ownerId: 'owner_1',
      });
    });

    const response = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${credential}`,
      },
    });
    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`Unexpected sandbox control upgrade: ${response.status}`);
    }
    const ws = response.webSocket;
    ws.accept();
    await completeHello(ws, 'hello-heartbeat-idle-stop', {
      providerInstanceId: cloudflareRef(sandboxId),
    });

    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'sandbox.ready',
        payload: { kiloReady: true, globalFeedAttached: true },
      })
    );
    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (_instance, state) => {
        expect((await loadDeadlines(state.storage)).idleStop).toEqual(expect.any(Number));
      });
    });

    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'sandbox.heartbeat',
        payload: {
          state: 'active',
          pendingMessages: 0,
          kilo: { ready: true },
          sessions: [{ kiloSessionId: ROOT_ID, state: 'active', idleForMs: 0 }],
        },
      })
    );
    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (instance, state) => {
        expect((await loadDeadlines(state.storage)).idleStop).toBeUndefined();
        expect(await instance.listRoutes()).toEqual([
          expect.objectContaining({ kiloSessionId: ROOT_ID, lastState: 'active' }),
        ]);
      });
    });

    ws.send(
      JSON.stringify({
        type: 'event',
        event: 'sandbox.heartbeat',
        payload: {
          state: 'idle',
          pendingMessages: 0,
          kilo: { ready: true },
          sessions: [{ kiloSessionId: ROOT_ID, state: 'idle', idleForMs: 0 }],
        },
      })
    );
    await vi.waitFor(async () => {
      await runInDurableObject(stub, async (instance, state) => {
        expect((await loadDeadlines(state.storage)).idleStop).toEqual(expect.any(Number));
        expect(await instance.listRoutes()).toEqual([
          expect.objectContaining({ kiloSessionId: ROOT_ID, lastState: 'idle' }),
        ]);
      });
    });
    ws.close();
  });

  it.each(['session.attach', 'session.prompt'] as const)(
    'persists valid %s demand before forwarding at the idle boundary',
    async operation => {
      const fixture = {
        sandboxId: `usr-${crypto.randomUUID().replaceAll('-', '')}`,
        ownerId: 'owner_idle_boundary',
        sessionId: GRANT_SESSION_ID,
        wrapperInstanceId: crypto.randomUUID(),
      } as const satisfies TerminalRuntimeFixture;
      const { control, socket, provider } = await initializeTerminalRuntime(fixture);
      const clock = vi.spyOn(Date, 'now');
      let held: RequestFrame | undefined;
      let pending: Promise<ResponseFrame> | undefined;
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        const idleStop = await runInDurableObject(control, async (_instance, state) => {
          const deadlines = await loadDeadlines(state.storage);
          if (deadlines.idleStop === undefined) throw new Error('Expected an idle deadline');
          await saveDeadlines(state.storage, {
            ...deadlines,
            heartbeatExpiry: deadlines.idleStop + DEADLINE_MS.heartbeatExpiry,
          });
          await state.storage.setAlarm(deadlines.idleStop);
          return deadlines.idleStop;
        });
        clock.mockReturnValue(idleStop - 1);
        const inbound = nextMessage(socket);
        pending = Promise.resolve(
          control.request({
            operation,
            session: {
              sessionId: fixture.sessionId,
              kiloSessionId: ROOT_ID,
              directory: '/workspace/terminal',
            },
            payload:
              operation === 'session.attach'
                ? { directory: '/workspace/terminal' }
                : {
                    messageId: 'msg_idle_boundary',
                    turn: { type: 'prompt', prompt: 'continue before idle expiry' },
                    agent: { mode: 'code', model: 'test' },
                  },
          })
        );
        held = requestFrameSchema.parse(JSON.parse(await inbound));
        expect(held.operation).toBe(operation);
        await runInDurableObject(control, async (_instance, state) => {
          const deadlines = await loadDeadlines(state.storage);
          expect(deadlines.idleStop).toBe(idleStop - 1 + DEADLINE_MS.idleStop);
          expect(deadlines.heartbeatExpiry).toBe(idleStop + DEADLINE_MS.heartbeatExpiry);
          expect(await state.storage.getAlarm()).toBe(deadlines.heartbeatExpiry);
        });
        acceptControlRequest(socket, held);
        held = undefined;
        await expect(pending).resolves.toMatchObject({ ok: true });
        clock.mockReturnValue(idleStop + 1);
        await expect(runDurableObjectAlarm(control)).resolves.toBe(true);
        await expect(control.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: fixture.wrapperInstanceId,
        });
        expect(provider.stop).not.toHaveBeenCalled();
        expect(provider.create).not.toHaveBeenCalled();
        socket.send(
          JSON.stringify({
            type: 'event',
            event: 'sandbox.heartbeat',
            payload: {
              state: 'active',
              kilo: { ready: true },
              sessions: [{ kiloSessionId: ROOT_ID, state: 'active', idleForMs: 0 }],
            },
          })
        );
        await vi.waitFor(async () => {
          await runInDurableObject(control, async (_instance, state) => {
            const deadlines = await loadDeadlines(state.storage);
            expect(deadlines.idleStop).toBeUndefined();
            expect(deadlines.heartbeatExpiry).toBe(idleStop + 1 + DEADLINE_MS.heartbeatExpiry);
            expect(await state.storage.getAlarm()).toBe(deadlines.heartbeatExpiry);
          });
        });
      } finally {
        if (held && socket.readyState === WebSocket.OPEN) acceptControlRequest(socket, held);
        await pending;
        clock.mockRestore();
        socket.close();
      }
    }
  );

  it('clears the transition log when the sandbox record is erased', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__control_erase_log');
    await runInDurableObject(stub, async instance => {
      await instance.claimCreate('intent_erase');
      expect(await instance.getTransitionLog()).not.toHaveLength(0);
      await instance.eraseRecord();
      expect(await instance.getTransitionLog()).toEqual([]);
      await expect(instance.getOwner()).resolves.toBeNull();
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({ state: 'stopped' });
    });
  });

  it.each([ROOT_ID, SECOND_ROOT_ID])(
    'does not mutate or quarantine routes for an unroutable session.event from %s',
    async rootKiloSessionId => {
      const sandboxId = 'sbx__control_event_unroutable';
      const credential = generateSandboxCredential();
      const stub = env.SANDBOX_CONTROL.getByName(sandboxId);
      await runInDurableObject(stub, async (instance, state) => {
        await instance.initializeOwner('owner_1');
        await seedRunningCloudflare(instance);
        await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
        await attachGrantedSession(instance, state, {
          sessionId: GRANT_SESSION_ID,
          kiloSessionId: ROOT_ID,
          directory: '/workspace/a',
          ownerId: 'owner_1',
        });
      });

      const response = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${credential}`,
        },
      });
      if (response.status !== 101 || !response.webSocket) {
        throw new Error(`Unexpected sandbox control upgrade: ${response.status}`);
      }
      response.webSocket.accept();
      await completeHello(response.webSocket, 'hello-event', {
        providerInstanceId: cloudflareRef(sandboxId),
      });
      const before = await stub.listRoutes();
      response.webSocket.send(
        JSON.stringify({
          type: 'event',
          event: 'session.event',
          session: { directory: '/workspace/other', rootKiloSessionId },
          payload: { type: 'message.updated', properties: { id: 'msg_1' } },
        })
      );
      await runInDurableObject(stub, async instance => {
        await expect(instance.listRoutes()).resolves.toEqual(before);
        await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
          state: 'running',
          stopTombstone: null,
        });
      });
      response.webSocket.close();
    }
  );

  it('isolates two session.prompt identities on one wrapper socket', async () => {
    const twoSessionId = 'sbx__control_two_session';
    const credential = generateSandboxCredential();
    const stub = env.SANDBOX_CONTROL.getByName(twoSessionId);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.initializeOwner('owner_1');
      await seedRunningCloudflare(instance);
      await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
      await attachGrantedSession(instance, state, {
        sessionId: GRANT_SESSION_ID,
        kiloSessionId: ROOT_ID,
        directory: '/workspace/a',
        ownerId: 'owner_1',
      });
      await attachGrantedSession(instance, state, {
        sessionId: SECOND_GRANT_SESSION_ID,
        kiloSessionId: SECOND_ROOT_ID,
        directory: '/workspace/b',
        ownerId: 'owner_1',
      });
    });

    const response = await SELF.fetch(`http://worker.test/sandbox-control/${twoSessionId}`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${credential}`,
      },
    });
    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`Unexpected sandbox control upgrade: ${response.status}`);
    }
    response.webSocket.accept();
    await completeHello(response.webSocket, 'hello-two-session', {
      providerInstanceId: cloudflareRef(twoSessionId),
    });
    signalWrapperReady(response.webSocket);
    await vi.waitFor(async () => {
      await expect(stub.getStatus()).resolves.toMatchObject({ connection: 'ready' });
    });

    const promptPayload = {
      messageId: INITIAL_MESSAGE_ID,
      turn: { type: 'prompt', prompt: 'from a' },
      agent: { mode: 'code', model: 'test' },
    };

    async function prompt(
      sessionId: string,
      kiloSessionId: string,
      directory: string,
      messageId: string
    ) {
      const inbound = nextMessage(response.webSocket!);
      const pending = runInDurableObject(stub, instance =>
        instance.request({
          operation: 'session.prompt',
          session: { sessionId, kiloSessionId, directory },
          payload: { ...promptPayload, messageId },
        })
      );
      const request = JSON.parse(await inbound) as {
        operation: string;
        requestId: string;
        session: { sessionId: string; kiloSessionId: string; directory: string };
        payload: { messageId: string };
      };
      expect(request).toMatchObject({
        operation: 'session.prompt',
        session: { sessionId, kiloSessionId, directory },
        payload: { messageId },
      });
      response.webSocket!.send(
        JSON.stringify({
          type: 'response',
          requestId: request.requestId,
          ok: true,
          result: { messageId, status: 'accepted' },
        })
      );
      await expect(pending).resolves.toMatchObject({
        ok: true,
        result: { messageId, status: 'accepted' },
      });
    }

    await prompt(GRANT_SESSION_ID, ROOT_ID, '/workspace/a', 'msg_a');
    await prompt(SECOND_GRANT_SESSION_ID, SECOND_ROOT_ID, '/workspace/b', 'msg_b');
    response.webSocket.close();
  });
});

describe('SandboxSession control-plane regressions', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ valid: true }));
  });

  type SessionStub = ReturnType<typeof env.SANDBOX_SESSION.getByName>;

  const agentA = { mode: 'code', model: 'kilo/anthropic/claude-sonnet-4', variant: 'high' };
  const modelB = 'kilo/openai/gpt-4.1';

  function messageFixture(sandboxProvider: 'cloudflare' | 'vercel' = 'cloudflare') {
    const id = crypto.randomUUID().replaceAll('-', '');
    const fixture = {
      sandboxId: `${sandboxProvider === 'vercel' ? 'ses' : 'usr'}-${id}`,
      sandboxProvider,
      ownerId: 'user_admission',
      sessionId: `workspace_${crypto.randomUUID()}`,
      wrapperInstanceId: crypto.randomUUID(),
    } as const satisfies TerminalRuntimeFixture;
    const session = env.SANDBOX_SESSION.getByName(`${fixture.ownerId}:${fixture.sessionId}`);
    return { fixture, session };
  }

  async function seedBlockedAdmission(agent: AgentSelectionOverride = agentA) {
    const { fixture, session } = messageFixture();
    await session.registerSession({
      identity: {
        sessionId: fixture.sessionId,
        userId: fixture.ownerId,
        orgId: 'stored-org',
        createdOnPlatform: 'stored-platform',
      },
      auth: { kiloSessionId: ROOT_ID, kilocodeToken: 'stored-test-token' },
      agent,
    });
    await runInDurableObject(session, (_instance, state) => {
      state.storage.kv.put('session_messages', [
        { messageId: 'msg_blocker', state: 'accepted', acceptedAt: Date.now() },
      ] satisfies SessionMessageRecord[]);
    });
    return { fixture, session };
  }

  function admissionState(session: SessionStub) {
    return runInDurableObject(session, (_instance, state) => ({
      metadata: state.storage.kv.get<SessionMetadata>('session_metadata'),
      messages: state.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [],
    }));
  }

  async function waitForAccepted(session: SessionStub, messageId: string) {
    await vi.waitFor(async () => {
      await expect(session.getMessageResult(messageId)).resolves.toMatchObject({
        type: 'found',
        result: { status: 'running' },
      });
    });
  }

  function completeTurn(session: SessionStub, messageId: string, wrapperInstanceId: string) {
    return session.receiveSandboxControlEvent({
      identity: { directory: '/workspace/terminal', kiloSessionId: ROOT_ID },
      wrapperInstanceId,
      payload: { type: 'session.message.outcome', properties: { messageId, status: 'completed' } },
    });
  }

  function sendOutcome(
    socket: WebSocket,
    messageId: string,
    status: 'completed' | 'failed' | 'cancelled' = 'completed'
  ): void {
    socket.send(
      JSON.stringify({
        type: 'event',
        event: 'session.event',
        session: { directory: '/workspace/terminal', kiloSessionId: ROOT_ID },
        payload: { type: 'session.message.outcome', properties: { messageId, status } },
      })
    );
  }

  function lifecycleEvents(session: SessionStub) {
    return runInDurableObject(session, (_instance, state) =>
      createEventQueries(drizzle(state.storage, { logger: false }), state.storage.sql)
        .findByFilters({
          eventTypes: ['cloud.message.sent', 'cloud.message.completed', 'cloud.message.failed'],
        })
        .map(event => ({
          type: event.stream_event_type,
          data: JSON.parse(event.payload) as Record<string, unknown>,
        }))
    );
  }

  function preparationSnapshots(session: SessionStub) {
    return runInDurableObject(session, (_instance, state) =>
      getPreparationSnapshots(
        createEventQueries(drizzle(state.storage, { logger: false }), state.storage.sql)
      ).map(event => JSON.parse(event.payload) as Record<string, unknown>)
    );
  }

  it('settles cancelled preparation and delivers B with its original acquisition after failed cleanup transfer and reset', async () => {
    const { fixture, session: originalSession } = messageFixture();
    let session = originalSession;
    const { control, socket, provider, allocations } = await initializeTerminalRuntime(fixture);
    const attach = Promise.withResolvers<RequestFrame>();
    const acquisitions: Parameters<typeof control.ensureReady>[0][] = [];
    let transferUnavailable = true;
    let held: RequestFrame | undefined;
    let dispatch: Promise<void> | undefined;
    let replacement: WebSocket | undefined;
    let stream: WebSocket | undefined;
    provider.stop.mockResolvedValue('retryable');
    await runInDurableObject(control, instance => {
      const prototype = Object.getPrototypeOf(instance) as typeof instance;
      const quarantine = instance.quarantineRuntime.bind(instance);
      const ensureReady = instance.ensureReady.bind(instance);
      vi.spyOn(prototype, 'quarantineRuntime').mockImplementation(async input => {
        if (transferUnavailable) throw new Error('temporary quarantine transfer failure');
        return quarantine(input);
      });
      vi.spyOn(prototype, 'ensureReady').mockImplementation(input => {
        acquisitions.push(input);
        return ensureReady(input);
      });
    });
    const requests = captureAndAcceptControlRequests(socket, request => {
      if (request.operation !== 'session.attach') return false;
      held = request;
      attach.resolve(request);
      return true;
    });
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: {
          initialTurn: { type: 'prompt', messageId: 'msg_ffffffffffff00000000000001', prompt: 'A' },
        },
      });
      const attachment = await attach.promise;
      const preparing = (await admissionState(session)).messages[0];
      if (!preparing?.preparationAttemptId) throw new Error('Expected preparation attempt A');
      expect(await preparationSnapshots(session)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'attempt_snapshot',
            attempt: expect.objectContaining({
              id: preparing.preparationAttemptId,
              status: 'running',
            }),
          }),
          expect.objectContaining({
            action: 'step_snapshot',
            stepSnapshot: expect.objectContaining({ status: 'running' }),
          }),
        ])
      );
      let joined = false;
      dispatch = runInDurableObject(session, instance => {
        joined = true;
        return instance.alarm();
      });
      await vi.waitFor(() => expect(joined).toBe(true));
      await expect(session.interruptExecution()).resolves.toEqual({ success: true });
      const cancelled = await preparationSnapshots(session);
      expect(cancelled).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'attempt_snapshot',
            attempt: expect.objectContaining({
              id: preparing.preparationAttemptId,
              status: 'failed',
              safeError: 'The message was interrupted',
            }),
          }),
          expect.objectContaining({
            action: 'step_snapshot',
            stepSnapshot: expect.objectContaining({
              status: 'failed',
              safeError: 'The message was interrupted',
            }),
          }),
        ])
      );
      for (const snapshot of cancelled) {
        if (snapshot.action === 'step_snapshot') {
          expect(snapshot.stepSnapshot).not.toMatchObject({ status: 'running' });
        }
      }
      const cleanup = await runInDurableObject(session, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
        return state.storage.kv.get('pending_runtime_cleanup');
      });
      expect(cleanup).toMatchObject({
        wrapperInstanceId: fixture.wrapperInstanceId,
        reason: 'preparation_interrupted',
      });
      const admittedAt = Date.now();
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_after_cancel_b', prompt: 'B' },
        })
      ).resolves.toMatchObject({ success: true, compatibilityDelivery: 'queued' });
      await vi.waitFor(async () => {
        expect((await admissionState(session)).messages[1]).toMatchObject({
          state: 'queued',
          preparationAttemptId: expect.any(String),
          deliveryDeadlineAt: expect.any(Number),
        });
      });
      acceptControlRequest(socket, attachment);
      held = undefined;
      await dispatch;
      const beforeReset = await admissionState(session);
      const b = beforeReset.messages[1];
      if (!b?.preparationAttemptId || b.deliveryDeadlineAt === undefined)
        throw new Error('Expected bounded acquisition B');
      const acquisitionB = { id: b.preparationAttemptId, deadlineAt: b.deliveryDeadlineAt };
      expect(b.deliveryDeadlineAt).toBeGreaterThanOrEqual(admittedAt + SESSION_DELIVERY_TIMEOUT_MS);
      expect(acquisitions.map(input => input.acquisition?.id)).toEqual([
        preparing.preparationAttemptId,
      ]);
      expect(beforeReset.messages[0]).toMatchObject({
        messageId: 'msg_ffffffffffff00000000000001',
        state: 'cancelled',
      });
      expect(requests.filter(request => request.operation === 'session.prompt')).toEqual([]);
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.stop).not.toHaveBeenCalled();

      await expect(
        runInDurableObject(session, (_instance, state) => state.abort('cleanup continuation reset'))
      ).rejects.toThrow('cleanup continuation reset');
      session = env.SANDBOX_SESSION.getByName(`${fixture.ownerId}:${fixture.sessionId}`);
      expect(await admissionState(session)).toEqual(beforeReset);
      expect(await preparationSnapshots(session)).toEqual(cancelled);
      await runInDurableObject(session, (_instance, state) => {
        expect(state.storage.kv.get('pending_runtime_cleanup')).toEqual(cleanup);
      });
      await session.receiveSandboxControlPreparing({
        identity: { directory: '/workspace/terminal', kiloSessionId: ROOT_ID },
        wrapperInstanceId: fixture.wrapperInstanceId,
        payload: {
          version: 2,
          attemptId: preparing.preparationAttemptId,
          triggerMessageId: 'msg_ffffffffffff00000000000001',
          revision: 1000,
          timestamp: Date.now(),
          step: 'ready',
          message: 'late preparation completion',
          action: 'attempt_completed',
        },
      });
      expect(await preparationSnapshots(session)).toEqual(cancelled);
      const response = await SELF.fetch(
        `http://worker.test/stream?sessionId=${fixture.sessionId}&userId=${fixture.ownerId}&replay=false`,
        { headers: { Upgrade: 'websocket' } }
      );
      stream = response.webSocket ?? undefined;
      if (response.status !== 101 || !stream) throw new Error('Expected session stream');
      const events: { streamEventType: string; data: unknown }[] = [];
      stream.addEventListener('message', event => {
        events.push(JSON.parse(String(event.data)));
      });
      stream.accept();
      await vi.waitFor(() => {
        expect(
          events.filter(event => event.streamEventType === 'preparing').map(event => event.data)
        ).toEqual(cancelled);
      });
      stream.close();

      transferUnavailable = false;
      await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
      await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopping',
        providerRef: cloudflareRef(fixture.sandboxId),
      });
      await runInDurableObject(session, (_instance, state) => {
        expect(state.storage.kv.get('pending_runtime_cleanup')).toBeUndefined();
      });
      expect(acquisitions.at(-1)?.acquisition).toEqual(acquisitionB);
      expect(provider.create).not.toHaveBeenCalled();
      await runInDurableObject(control, async (_instance, state) => {
        expect(await state.storage.get('acquisition_receipts')).toEqual([
          expect.objectContaining({ id: preparing.preparationAttemptId }),
        ]);
      });

      allocations.delete(cloudflareRef(fixture.sandboxId));
      await fireControlDeadline(control, 'stopAttempt');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
      });
      await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
      expect(provider.launch).toHaveBeenCalledTimes(1);
      const launch = provider.launch.mock.calls[0];
      if (!launch) throw new Error('Expected one replacement launch for B');
      const replacementFixture = { ...fixture, wrapperInstanceId: crypto.randomUUID() };
      replacement = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
      await completeHello(replacement, 'hello_after_cancel', {
        providerInstanceId: launch[0],
        wrapperInstanceId: replacementFixture.wrapperInstanceId,
      });
      const replacementRequests = captureAndAcceptControlRequests(replacement);
      signalWrapperReady(replacement);
      await waitForWrapperReady(replacementFixture);
      await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
      await waitForAccepted(session, 'msg_after_cancel_b');
      await session.failWaitingMessages(
        'late_cancelled_runtime_failure',
        fixture.wrapperInstanceId
      );
      await expect(
        control.quarantineRuntime({
          ownerId: fixture.ownerId,
          sessionId: fixture.sessionId,
          wrapperInstanceId: fixture.wrapperInstanceId,
          reason: 'late_cancelled_runtime_cleanup',
        })
      ).resolves.toEqual({ quarantined: false });
      expect((await admissionState(session)).messages).toMatchObject([
        { messageId: 'msg_ffffffffffff00000000000001', state: 'cancelled' },
        {
          ...b,
          state: 'accepted',
          wrapperInstanceId: replacementFixture.wrapperInstanceId,
        },
      ]);
      const continuations = acquisitions.filter(input => input.acquisition?.id === acquisitionB.id);
      expect(continuations).toHaveLength(3);
      expect(continuations.map(input => input.acquisition)).toEqual([
        acquisitionB,
        acquisitionB,
        acquisitionB,
      ]);
      expect(continuations.every(input => input.allowCreate === undefined)).toBe(true);
      expect(
        replacementRequests
          .filter(request => request.operation === 'session.prompt')
          .map(request => sessionPromptPayloadSchema.parse(request.payload).messageId)
      ).toEqual(['msg_after_cancel_b']);
      expect(requests.filter(request => request.operation === 'session.prompt')).toEqual([]);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.stop).toHaveBeenCalledTimes(2);
      expect(allocations).toEqual(new Set([launch[0]]));
    } finally {
      if (held && socket.readyState === WebSocket.OPEN) acceptControlRequest(socket, held);
      await dispatch;
      await session.interruptExecution();
      stream?.close();
      socket.close();
      replacement?.close();
    }
  });

  it.each([
    { sandboxProvider: 'cloudflare', operation: 'session.attach' },
    { sandboxProvider: 'cloudflare', operation: 'session.prompt' },
    { sandboxProvider: 'vercel', operation: 'session.attach' },
    { sandboxProvider: 'vercel', operation: 'session.prompt' },
  ] as const)(
    'rejects delayed cancelled A $operation RPCs without reaching or renewing replacement B on $sandboxProvider',
    async ({ sandboxProvider, operation }) => {
      const { fixture, session } = messageFixture(sandboxProvider);
      const { control, socket, provider, allocations, providerRef } =
        await initializeTerminalRuntime(fixture);
      const release = Promise.withResolvers<void>();
      let heldRequest: Parameters<typeof control.request>[0] | undefined;
      let delayedResponse: ResponseFrame | undefined;
      let delayedError: unknown;
      let transferUnavailable = true;
      let dispatchA: Promise<void> | undefined;
      let dispatchB: Promise<boolean> | undefined;
      let replacement: WebSocket | undefined;
      let replacementAttachment: RequestFrame | undefined;
      const clock = vi.spyOn(Date, 'now');
      provider.stop.mockResolvedValue('retryable');
      await runInDurableObject(control, instance => {
        const prototype = Object.getPrototypeOf(instance) as typeof instance;
        const request = instance.request.bind(instance);
        const quarantine = instance.quarantineRuntime.bind(instance);
        vi.spyOn(prototype, 'request').mockImplementation(async input => {
          if (heldRequest || input.operation !== operation) return request(input);
          heldRequest = input;
          await release.promise;
          try {
            delayedResponse = await request(input);
            return delayedResponse;
          } catch (error) {
            delayedError = error;
            throw error;
          }
        });
        vi.spyOn(prototype, 'quarantineRuntime').mockImplementation(input => {
          if (transferUnavailable) throw new Error('temporary quarantine transfer failure');
          return quarantine(input);
        });
      });
      const oldRequests = captureAndAcceptControlRequests(socket);
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        await session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
          agent: agentA,
          workspace: {
            sandboxId: fixture.sandboxId,
            workspacePath: '/workspace/terminal',
            sandboxProvider,
          },
          message: {
            initialTurn: {
              type: 'prompt',
              messageId: 'msg_ffffffffffff00000000000002',
              prompt: 'A',
            },
          },
        });
        await vi.waitFor(() => expect(heldRequest).toBeDefined());
        expect(heldRequest).toMatchObject({
          operation,
          session: {
            sessionId: fixture.sessionId,
            kiloSessionId: ROOT_ID,
            directory: '/workspace/terminal',
          },
        });
        expect(oldRequests.filter(request => request.operation === operation)).toEqual([]);
        let joined = false;
        dispatchA = runInDurableObject(session, instance => {
          joined = true;
          return instance.alarm();
        });
        await vi.waitFor(() => expect(joined).toBe(true));
        await expect(session.interruptExecution()).resolves.toEqual({ success: true });
        await expect(
          session.getMessageResult('msg_ffffffffffff00000000000002')
        ).resolves.toMatchObject({
          type: 'found',
          result: { status: 'interrupted' },
        });
        await runInDurableObject(session, (_instance, state) => {
          expect(state.storage.kv.get('pending_runtime_cleanup')).toMatchObject({
            wrapperInstanceId: fixture.wrapperInstanceId,
            reason: 'preparation_interrupted',
          });
        });
        await expect(
          session.admitSubmittedMessage({
            userId: fixture.ownerId,
            turn: { type: 'prompt', id: 'msg_replacement_b', prompt: 'B' },
          })
        ).resolves.toMatchObject({ success: true, compatibilityDelivery: 'queued' });
        await vi.waitFor(async () => {
          expect((await admissionState(session)).messages[1]).toMatchObject({
            state: 'queued',
            preparationAttemptId: expect.any(String),
            deliveryDeadlineAt: expect.any(Number),
          });
        });
        expect(provider.stop).not.toHaveBeenCalled();
        expect(provider.create).not.toHaveBeenCalled();
        expect(delayedResponse).toBeUndefined();
        expect(delayedError).toBeUndefined();

        transferUnavailable = false;
        await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
        await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
        await expect(control.getPhysicalRecord()).resolves.toMatchObject({
          state: 'stopping',
          providerRef,
        });
        allocations.delete(providerRef);
        await fireControlDeadline(control, 'stopAttempt');
        await expect(control.getPhysicalRecord()).resolves.toMatchObject({
          state: 'stopped',
          providerRef: null,
        });
        if (sandboxProvider === 'vercel') {
          await control.ensureReady({
            ownerId: fixture.ownerId,
            sessionId: fixture.sessionId,
            provider: sandboxProvider,
            allowCreate: true,
          });
        }
        await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
        expect(provider.launch).toHaveBeenCalledTimes(1);
        const launch = provider.launch.mock.calls[0];
        if (!launch) throw new Error('Expected a replacement allocation for B');
        expect(launch[0]).not.toBe(providerRef);
        const replacementFixture = { ...fixture, wrapperInstanceId: crypto.randomUUID() };
        replacement = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
        await completeHello(replacement, 'hello_delayed_rpc_replacement', {
          providerInstanceId: launch[0],
          wrapperInstanceId: replacementFixture.wrapperInstanceId,
        });
        const replacementRequests = captureAndAcceptControlRequests(replacement, request => {
          if (request.operation !== 'session.attach' || replacementAttachment) return false;
          replacementAttachment = request;
          return true;
        });
        signalWrapperReady(replacement);
        await waitForWrapperReady(replacementFixture);
        dispatchB = runDurableObjectAlarm(session);
        await vi.waitFor(() => expect(replacementAttachment).toBeDefined());
        if (!replacementAttachment) throw new Error('Expected B attachment before its prompt');
        expect(replacementAttachment).toMatchObject({
          operation: 'session.attach',
          payload: { preparation: { triggerMessageId: 'msg_replacement_b' } },
        });
        const beforeDelivery = await admissionState(session);
        expect(beforeDelivery.messages).toMatchObject([
          { messageId: 'msg_ffffffffffff00000000000002', state: 'cancelled' },
          {
            messageId: 'msg_replacement_b',
            state: 'queued',
            wrapperInstanceId: replacementFixture.wrapperInstanceId,
          },
        ]);
        const deadlinesBefore = await runInDurableObject(control, async (_instance, state) => ({
          deadlines: await loadDeadlines(state.storage),
          alarmAt: await state.storage.getAlarm(),
        }));
        expect(deadlinesBefore.deadlines.idleStop).toEqual(expect.any(Number));
        clock.mockReturnValue(Date.now() + 1_000);
        await runInDurableObject(control, () => release.resolve());
        await dispatchA;
        expect([...replacementRequests]).toEqual([replacementAttachment]);
        expect(delayedResponse).toBeUndefined();
        expect(delayedError).toMatchObject({ message: 'Sandbox wrapper runtime changed' });
        expect(await admissionState(session)).toEqual(beforeDelivery);
        await runInDurableObject(control, async (_instance, state) => {
          expect(await loadDeadlines(state.storage)).toEqual(deadlinesBefore.deadlines);
          expect(await state.storage.getAlarm()).toBe(deadlinesBefore.alarmAt);
        });
        clock.mockRestore();

        acceptControlRequest(replacement, replacementAttachment);
        replacementAttachment = undefined;
        await expect(dispatchB).resolves.toBe(true);
        await waitForAccepted(session, 'msg_replacement_b');
        expect(replacementRequests.map(request => request.operation)).toEqual([
          'session.attach',
          'session.prompt',
        ]);
        expect(
          replacementRequests
            .filter(request => request.operation === 'session.prompt')
            .map(request => sessionPromptPayloadSchema.parse(request.payload).messageId)
        ).toEqual(['msg_replacement_b']);
        expect(oldRequests.filter(request => request.operation === operation)).toEqual([]);
        expect((await admissionState(session)).messages).toMatchObject([
          { messageId: 'msg_ffffffffffff00000000000002', state: 'cancelled' },
          {
            ...beforeDelivery.messages[1],
            state: 'accepted',
            unresolvedDispatch: undefined,
            wrapperInstanceId: replacementFixture.wrapperInstanceId,
          },
        ]);
        await expect(control.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: replacementFixture.wrapperInstanceId,
        });
        expect(provider.create).toHaveBeenCalledTimes(1);
        expect(provider.stop).toHaveBeenCalledTimes(2);
        expect(allocations).toEqual(new Set([launch[0]]));
      } finally {
        release.resolve();
        if (replacementAttachment && replacement?.readyState === WebSocket.OPEN) {
          acceptControlRequest(replacement, replacementAttachment);
        }
        await dispatchA;
        await dispatchB;
        clock.mockRestore();
        await session.interruptExecution();
        socket.close();
        replacement?.close();
      }
    }
  );

  it('persists an admission alarm before the first RPC and recovers the head on a fresh ID after reset', async () => {
    const { fixture, session: originalSession } = messageFixture();
    let session = originalSession;
    const { control, socket, provider } = await initializeTerminalRuntime(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);
    const requests = captureAndAcceptControlRequests(socket);
    let entered = false;
    const release = Promise.withResolvers<void>();
    await runInDurableObject(control, instance => {
      const prototype = Object.getPrototypeOf(instance) as typeof instance;
      const getStatus = instance.getStatus.bind(instance);
      vi.spyOn(prototype, 'getStatus').mockImplementationOnce(async () => {
        entered = true;
        await release.promise;
        return getStatus();
      });
    });
    try {
      const admittedAt = Date.now();
      await expect(
        session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
          agent: agentA,
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          message: {
            initialTurn: {
              type: 'prompt',
              messageId: 'msg_ffffffffffff00000000000003',
              prompt: 'head A',
            },
          },
        })
      ).resolves.toMatchObject({ success: true, compatibilityDelivery: 'queued' });
      await vi.waitFor(() => expect(entered).toBe(true));
      const before = await admissionState(session);
      const alarmAt = await runInDurableObject(session, (_instance, state) =>
        state.storage.getAlarm()
      );
      expect(alarmAt).toBeGreaterThanOrEqual(admittedAt);
      expect(before.messages).toMatchObject([
        {
          messageId: 'msg_ffffffffffff00000000000003',
          state: 'queued',
          deliveryDeadlineAt: expect.any(Number),
          preparationAttemptId: expect.any(String),
        },
      ]);
      expect(before.messages[0]?.deliveryDeadlineAt).toBeGreaterThanOrEqual(
        admittedAt + SESSION_DELIVERY_TIMEOUT_MS
      );
      expect(provider.create).not.toHaveBeenCalled();

      await expect(
        runInDurableObject(session, (_instance, state) => state.abort('admission reset'))
      ).rejects.toThrow('admission reset');
      release.resolve();
      session = env.SANDBOX_SESSION.get(env.SANDBOX_SESSION.idFromString(session.id.toString()));
      expect(await admissionState(session)).toEqual(before);
      expect(
        await runInDurableObject(session, (_instance, state) => state.storage.getAlarm())
      ).toBe(alarmAt);
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_fresh', command: 'status', arguments: '' },
        })
      ).resolves.toMatchObject({ success: true });
      await waitForAccepted(session, 'msg_ffffffffffff00000000000003');
      const recovered = await admissionState(session);
      expect(recovered.messages).toMatchObject([
        {
          ...before.messages[0],
          state: 'accepted',
          wrapperInstanceId: fixture.wrapperInstanceId,
        },
        { messageId: 'msg_fresh', state: 'queued' },
      ]);
      expect(requests.filter(request => request.operation === 'session.prompt')).toHaveLength(1);
      sendOutcome(socket, 'msg_ffffffffffff00000000000003');
      await waitForAccepted(session, 'msg_fresh');
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => sessionPromptPayloadSchema.parse(request.payload).messageId)
      ).toEqual(['msg_ffffffffffff00000000000003', 'msg_fresh']);
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.launch).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await session.interruptExecution();
      socket.close();
    }
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'persists an early %s outcome and never resurrects it when acknowledgement arrives late',
    async status => {
      const { fixture, session } = messageFixture();
      const { control, socket, provider } = await initializeTerminalRuntime(fixture);
      const prompt = Promise.withResolvers<RequestFrame>();
      let held: RequestFrame | undefined;
      let dispatch: Promise<void> | undefined;
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        captureAndAcceptControlRequests(socket, request => {
          if (
            request.operation !== 'session.prompt' ||
            sessionPromptPayloadSchema.parse(request.payload).messageId !==
              'msg_ffffffffffff00000000000004'
          )
            return false;
          held = request;
          prompt.resolve(request);
          return true;
        });
        await session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
          agent: agentA,
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          message: {
            initialTurn: {
              type: 'command',
              messageId: 'msg_ffffffffffff00000000000004',
              command: 'review',
              arguments: '--all',
            },
          },
        });
        const request = await prompt.promise;
        await session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_after_early', command: 'status', arguments: '' },
        });
        let joined = false;
        dispatch = runInDurableObject(session, instance => {
          joined = true;
          return instance.alarm();
        });
        await vi.waitFor(() => expect(joined).toBe(true));
        sendOutcome(socket, 'msg_ffffffffffff00000000000004', status);
        await vi.waitFor(async () => {
          await expect(
            session.getMessageResult('msg_ffffffffffff00000000000004')
          ).resolves.toMatchObject({
            type: 'found',
            result: { status: status === 'cancelled' ? 'interrupted' : status },
          });
        });
        await waitForAccepted(session, 'msg_after_early');
        const terminal = await admissionState(session);
        const events = await lifecycleEvents(session);
        expect(
          events.filter(event => event.data.messageId === 'msg_ffffffffffff00000000000004')
        ).toMatchObject([
          {
            type: status === 'completed' ? 'cloud.message.completed' : 'cloud.message.failed',
            data: {
              messageId: 'msg_ffffffffffff00000000000004',
              status: status === 'cancelled' ? 'interrupted' : status,
              delivery: 'sent',
              accepted: true,
            },
          },
        ]);
        acceptControlRequest(socket, request);
        held = undefined;
        await dispatch;
        expect(await admissionState(session)).toEqual(terminal);
        expect(await lifecycleEvents(session)).toEqual(events);
        await expect(
          session.admitSubmittedMessage({
            userId: fixture.ownerId,
            turn: {
              type: 'command',
              id: 'msg_ffffffffffff00000000000004',
              command: 'review',
              arguments: '--all',
            },
          })
        ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
        await expect(control.getStatus()).resolves.toMatchObject({
          physical: 'running',
          connection: 'ready',
          wrapperInstanceId: fixture.wrapperInstanceId,
        });
        expect(provider.stop).not.toHaveBeenCalled();
      } finally {
        if (held && socket.readyState === WebSocket.OPEN) acceptControlRequest(socket, held);
        await dispatch;
        await session.interruptExecution();
        socket.close();
      }
    }
  );

  it('ignores an old outcome and late preparation after B is accepted without quarantining B', async () => {
    const { fixture, session } = messageFixture();
    const { control, socket, provider } = await initializeTerminalRuntime(fixture);
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      captureAndAcceptControlRequests(socket);
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: {
          initialTurn: { type: 'prompt', messageId: 'msg_ffffffffffff00000000000005', prompt: 'A' },
        },
      });
      await waitForAccepted(session, 'msg_ffffffffffff00000000000005');
      const attemptId = (await admissionState(session)).messages[0]?.preparationAttemptId;
      expect(attemptId).toEqual(expect.any(String));
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'command', id: 'msg_current_b', command: 'status', arguments: '' },
      });
      sendOutcome(socket, 'msg_ffffffffffff00000000000005');
      await waitForAccepted(session, 'msg_current_b');
      const events = await lifecycleEvents(session);
      sendOutcome(socket, 'msg_ffffffffffff00000000000005');
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'session.preparing',
          session: { directory: '/workspace/terminal', kiloSessionId: ROOT_ID },
          payload: {
            version: 2,
            attemptId,
            triggerMessageId: 'msg_ffffffffffff00000000000005',
            revision: 100,
            timestamp: Date.now(),
            step: 'workspace_setup',
            message: 'late setup result',
            action: 'update',
          },
        })
      );
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'session.event',
          session: { directory: '/workspace/terminal', kiloSessionId: ROOT_ID },
          payload: {
            type: 'session.status',
            properties: { sessionID: ROOT_ID, status: { type: 'busy' } },
          },
        })
      );
      await vi.waitFor(async () => {
        await runInDurableObject(session, (_instance, state) => {
          const stored = createEventQueries(
            drizzle(state.storage, { logger: false }),
            state.storage.sql
          ).findByFilters({ eventTypes: ['kilocode'] });
          expect(stored.map(event => JSON.parse(event.payload))).toContainEqual(
            expect.objectContaining({ type: 'session.status' })
          );
        });
      });
      expect((await admissionState(session)).messages).toMatchObject([
        { messageId: 'msg_ffffffffffff00000000000005', state: 'completed' },
        {
          messageId: 'msg_current_b',
          state: 'accepted',
          wrapperInstanceId: fixture.wrapperInstanceId,
        },
      ]);
      expect(await lifecycleEvents(session)).toEqual(events);
      await expect(control.getStatus()).resolves.toMatchObject({
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: fixture.wrapperInstanceId,
      });
      expect(provider.stop).not.toHaveBeenCalled();
      sendOutcome(socket, 'msg_current_b');
      await vi.waitFor(async () => {
        await expect(session.getMessageResult('msg_current_b')).resolves.toMatchObject({
          type: 'found',
          result: { status: 'completed' },
        });
      });
    } finally {
      await session.interruptExecution();
      socket.close();
    }
  });

  it.each(['execution', 'setup'] as const)(
    'actually stops %s when markAsInterrupted precedes interruptExecution',
    async phase => {
      const { fixture, session } = messageFixture();
      const { control, socket, provider, allocations } = await initializeTerminalRuntime(fixture);
      const entered = Promise.withResolvers<void>();
      let activeWork = false;
      let held: RequestFrame | undefined;
      provider.stop.mockImplementation(async ref => {
        activeWork = false;
        if (ref) allocations.delete(ref);
        return 'terminal';
      });
      const requests = captureAndAcceptControlRequests(socket, request => {
        if (request.operation === 'session.attach' && phase === 'setup') {
          activeWork = true;
          held = request;
          entered.resolve();
          return true;
        }
        if (request.operation === 'session.prompt') {
          activeWork = true;
          entered.resolve();
        }
        if (request.operation === 'session.abort') activeWork = false;
        return false;
      });
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        await session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
          agent: agentA,
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          message: {
            initialTurn: {
              type: 'prompt',
              messageId: 'msg_ffffffffffff00000000000006',
              prompt: 'interrupt me',
            },
          },
        });
        await entered.promise;
        if (phase === 'execution') await waitForAccepted(session, 'msg_ffffffffffff00000000000006');
        await session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_cancel_follower', command: 'status', arguments: '' },
        });
        expect(activeWork).toBe(true);
        if (phase === 'setup') {
          await expect(control.detachSession(fixture.sessionId)).resolves.toEqual({
            existed: true,
          });
        }
        await session.markAsInterrupted();
        await expect(session.interruptExecution()).resolves.toMatchObject({ success: true });
        await vi.waitFor(() => expect(activeWork).toBe(false));
        expect((await admissionState(session)).messages).toMatchObject([
          { messageId: 'msg_ffffffffffff00000000000006', state: 'cancelled' },
          { messageId: 'msg_cancel_follower', state: 'cancelled' },
        ]);
        if (phase === 'execution') {
          expect(requests.filter(request => request.operation === 'session.abort')).toMatchObject([
            {
              session: {
                sessionId: fixture.sessionId,
                kiloSessionId: ROOT_ID,
                directory: '/workspace/terminal',
              },
              payload: { messageId: 'msg_ffffffffffff00000000000006' },
            },
          ]);
          expect(provider.stop).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(async () => {
            await expect(control.getPhysicalRecord()).resolves.toMatchObject({
              state: 'stopped',
              providerRef: null,
            });
          });
          expect(provider.stop).toHaveBeenCalledTimes(1);
          expect(provider.stop.mock.calls[0]?.[0]).toBe(cloudflareRef(fixture.sandboxId));
          expect(requests.filter(request => request.operation === 'session.prompt')).toEqual([]);
        }
        const events = await lifecycleEvents(session);
        const failures = events.filter(event => event.type === 'cloud.message.failed');
        expect(failures.map(event => event.data.messageId).sort()).toEqual([
          'msg_cancel_follower',
          'msg_ffffffffffff00000000000006',
        ]);
        expect(
          failures.find(event => event.data.messageId === 'msg_ffffffffffff00000000000006')?.data
        ).toMatchObject({
          status: 'interrupted',
          accepted: phase === 'execution',
        });
        expect(
          failures.find(event => event.data.messageId === 'msg_cancel_follower')?.data
        ).toMatchObject({
          status: 'interrupted',
          accepted: false,
        });
        await runInDurableObject(session, instance => instance.alarm());
        expect(provider.create).not.toHaveBeenCalled();
      } finally {
        if (held && socket.readyState === WebSocket.OPEN) acceptControlRequest(socket, held);
        await session.interruptExecution();
        socket.close();
      }
    }
  );

  it('continues slow physical cleanup and waits for a fresh message to create a replacement', async () => {
    const { fixture, session } = messageFixture();
    const { control, socket, provider, allocations } = await initializeTerminalRuntime(fixture);
    provider.stop.mockResolvedValue('retryable');
    let replacement: WebSocket | undefined;
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      captureAndAcceptControlRequests(socket);
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: {
          initialTurn: { type: 'prompt', messageId: 'msg_ffffffffffff00000000000007', prompt: 'A' },
        },
      });
      await waitForAccepted(session, 'msg_ffffffffffff00000000000007');
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'sandbox.heartbeat',
          payload: { state: 'active', kilo: { ready: false }, sessions: [] },
        })
      );
      await vi.waitFor(async () => {
        await expect(
          session.getMessageResult('msg_ffffffffffff00000000000007')
        ).resolves.toMatchObject({
          type: 'found',
          result: { status: 'failed' },
        });
        await runInDurableObject(control, async (instance, state) => {
          expect((await instance.getPhysicalRecord()).stopTombstone?.attempts).toBe(1);
          expect((await loadDeadlines(state.storage)).stopAttempt).toBeLessThan(
            Date.now() + DEADLINE_MS.stopAttempt
          );
        });
      });
      expect(
        (await lifecycleEvents(session)).filter(event => event.type === 'cloud.message.failed')
      ).toMatchObject([
        {
          data: {
            messageId: 'msg_ffffffffffff00000000000007',
            accepted: true,
            delivery: 'sent',
            reason: 'kilo_unhealthy',
          },
        },
      ]);
      expect(provider.stop).toHaveBeenCalledTimes(1);
      for (let attempt = 2; attempt <= DEADLINE_MS.stopAttemptLadder.length; attempt++) {
        await fireControlDeadline(control, 'stopAttempt');
        expect(provider.stop.mock.calls.map(([ref]) => ref)).toEqual(
          Array.from({ length: attempt }, () => cloudflareRef(fixture.sandboxId))
        );
        expect((await control.getPhysicalRecord()).stopTombstone?.attempts).toBe(attempt);
      }
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'unknown',
        providerRef: cloudflareRef(fixture.sandboxId),
        stopTombstone: { attempts: 5, wrapperInstanceId: fixture.wrapperInstanceId },
      });
      await expect(control.getStatus()).resolves.toMatchObject({ connection: 'disconnected' });
      const observations = provider.observe.mock.calls.length;
      await fireControlDeadline(control, 'reconciliation');
      expect(provider.stop).toHaveBeenCalledTimes(6);
      await fireControlDeadline(control, 'reconciliation');
      expect(provider.observe).toHaveBeenCalledTimes(observations + 2);
      expect(provider.stop.mock.calls.map(([ref]) => ref)).toEqual(
        Array.from({ length: 7 }, () => cloudflareRef(fixture.sandboxId))
      );
      expect((await control.getPhysicalRecord()).stopTombstone?.attempts).toBe(5);
      expect(provider.create).not.toHaveBeenCalled();

      allocations.delete(cloudflareRef(fixture.sandboxId));
      await fireControlDeadline(control, 'reconciliation');
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
        stopTombstone: null,
      });
      await runInDurableObject(session, instance => instance.alarm());
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.launch).not.toHaveBeenCalled();
      const nextFixture = { ...fixture, wrapperInstanceId: crypto.randomUUID() };
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_recovered', prompt: 'try again' },
        })
      ).resolves.toMatchObject({ success: true });
      await vi.waitFor(() => expect(provider.launch).toHaveBeenCalledTimes(1));
      const launch = provider.launch.mock.calls[0];
      if (!launch) throw new Error('Expected replacement wrapper launch');
      expect(launch[0]).not.toBe(cloudflareRef(fixture.sandboxId));
      expect((await control.getPhysicalRecord()).providerRef).toBe(launch[0]);
      replacement = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
      await completeHello(replacement, 'hello_cleanup_recovery', {
        providerInstanceId: launch[0],
        wrapperInstanceId: nextFixture.wrapperInstanceId,
      });
      captureAndAcceptControlRequests(replacement);
      signalWrapperReady(replacement);
      await waitForWrapperReady(nextFixture);
      await expect(runDurableObjectAlarm(session)).resolves.toBe(true);
      await waitForAccepted(session, 'msg_recovered');
      await session.failWaitingMessages('late_old_runtime_failure', fixture.wrapperInstanceId);
      expect((await admissionState(session)).messages).toMatchObject([
        {
          messageId: 'msg_ffffffffffff00000000000007',
          state: 'failed',
          failedReason: 'kilo_unhealthy',
        },
        {
          messageId: 'msg_recovered',
          state: 'accepted',
          wrapperInstanceId: nextFixture.wrapperInstanceId,
        },
      ]);
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.launch).toHaveBeenCalledTimes(1);
      expect(provider.stop).toHaveBeenCalledTimes(7);
      expect(provider.create.mock.calls[0]?.[0]).toMatchObject({
        createdAt: expect.any(Number),
        billing: { sandboxId: fixture.sandboxId, actor: { type: 'user', id: fixture.ownerId } },
      });
    } finally {
      await session.interruptExecution();
      socket.close();
      replacement?.close();
    }
  });

  it('normalizes initial and command models once without preflight or leaking session finalization', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    const finalization = {
      autoCommit: true,
      condenseOnComplete: true,
      gateThreshold: 'warning',
    } as const;
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      const requests = captureAndAcceptControlRequests(socket);
      await expect(
        session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
          agent: { mode: 'architect', model: 'kilo/fake-deterministic', variant: 'high' },
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          finalization,
          message: {
            initialTurn: {
              type: 'prompt',
              messageId: INITIAL_MESSAGE_ID,
              prompt: 'initial prompt',
            },
          },
        })
      ).resolves.toMatchObject({ success: true });
      await waitForAccepted(session, INITIAL_MESSAGE_ID);
      await completeTurn(session, INITIAL_MESSAGE_ID, fixture.wrapperInstanceId);
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_command_model', command: 'review', arguments: '--all' },
          agent: { mode: 'reviewer', model: ' kilo/kilo/example ', variant: 'low' },
        })
      ).resolves.toMatchObject({ success: true });
      await waitForAccepted(session, 'msg_command_model');
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: INITIAL_MESSAGE_ID,
          turn: { type: 'prompt', prompt: 'initial prompt' },
          agent: { mode: 'architect', model: 'fake-deterministic', variant: 'high' },
          finalization: { autoCommit: true, condenseOnComplete: true },
        },
        {
          messageId: 'msg_command_model',
          turn: { type: 'command', command: 'review', arguments: '--all' },
          agent: { mode: 'reviewer', model: 'kilo/example', variant: 'low' },
        },
      ]);
      expect((await admissionState(session)).metadata?.finalization).toEqual(finalization);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await session.interruptExecution();
      socket.close();
    }
  });

  it('delivers frozen A then B after eviction and reconnect without replay rewinding defaults', async () => {
    const { fixture, session: originalSession } = messageFixture();
    let session = originalSession;
    const credential = generateSandboxCredential();
    await seedCredential(credential, fixture.sandboxId);
    await runInDurableObject(
      env.SANDBOX_CONTROL.getByName(fixture.sandboxId),
      seedRunningCloudflare
    );
    await installProvider(
      env.SANDBOX_CONTROL.getByName(fixture.sandboxId),
      cloudflareRef(fixture.sandboxId)
    );
    const socket = await connect(credential, fixture.sandboxId);
    let replacement: WebSocket | undefined;
    try {
      const waitingRequests = captureAndAcceptControlRequests(socket);
      await expect(
        session.createSessionWithInitialAdmission({
          identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
          auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
          agent: agentA,
          workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
          message: { initialTurn: { type: 'prompt', messageId: INITIAL_MESSAGE_ID, prompt: 'A' } },
        })
      ).resolves.toMatchObject({ success: true, compatibilityDelivery: 'queued' });
      await runInDurableObject(session, instance => instance.alarm());
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_b', prompt: 'B' },
          agent: { model: modelB, mode: 'reviewer' },
        })
      ).resolves.toMatchObject({ success: true });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_c', prompt: 'inherits B' },
        })
      ).resolves.toMatchObject({ success: true });
      const beforeReplay = await admissionState(session);
      expect(beforeReplay.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      const replay: SubmittedSessionMessageRequest = {
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: INITIAL_MESSAGE_ID, prompt: 'A' },
        agent: { model: 'anthropic/claude-sonnet-4' },
      };
      await expect(session.admitSubmittedMessage(replay)).resolves.toMatchObject({
        success: true,
        compatibilityDelivery: 'queued',
      });
      await expect(
        session.admitSubmittedMessage({ ...replay, agent: { model: modelB } })
      ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
      await runInDurableObject(session, instance => instance.alarm());
      expect(await admissionState(session)).toEqual(beforeReplay);
      expect(waitingRequests).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);

      await abortAllDurableObjects();
      await installProvider(
        env.SANDBOX_CONTROL.getByName(fixture.sandboxId),
        cloudflareRef(fixture.sandboxId)
      );
      session = env.SANDBOX_SESSION.get(env.SANDBOX_SESSION.idFromString(session.id.toString()));
      expect(await admissionState(session)).toEqual(beforeReplay);
      replacement = await connect(credential, fixture.sandboxId);
      await completeHello(replacement, 'hello_frozen_recreated', {
        providerInstanceId: cloudflareRef(fixture.sandboxId),
        wrapperInstanceId: fixture.wrapperInstanceId,
      });
      const requests = captureAndAcceptControlRequests(replacement);
      signalWrapperReady(replacement);
      await waitForWrapperReady(fixture);
      await runInDurableObject(session, instance => instance.alarm());
      await waitForAccepted(session, INITIAL_MESSAGE_ID);
      const accepted = await admissionState(session);
      await expect(session.admitSubmittedMessage(replay)).resolves.toMatchObject({
        success: true,
        compatibilityDelivery: 'sent',
      });
      expect(await admissionState(session)).toEqual(accepted);
      await completeTurn(session, INITIAL_MESSAGE_ID, fixture.wrapperInstanceId);
      await waitForAccepted(session, 'msg_b');
      await completeTurn(session, 'msg_b', fixture.wrapperInstanceId);
      await waitForAccepted(session, 'msg_c');
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: INITIAL_MESSAGE_ID,
          turn: { type: 'prompt', prompt: 'A' },
          agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
        },
        {
          messageId: 'msg_b',
          turn: { type: 'prompt', prompt: 'B' },
          agent: { mode: 'reviewer', model: 'openai/gpt-4.1' },
        },
        {
          messageId: 'msg_c',
          turn: { type: 'prompt', prompt: 'inherits B' },
          agent: { mode: 'code', model: 'openai/gpt-4.1' },
        },
      ]);
      const terminal = await admissionState(session);
      await expect(session.admitSubmittedMessage(replay)).resolves.toMatchObject({
        success: false,
        code: 'BAD_REQUEST',
      });
      expect(await admissionState(session)).toEqual(terminal);
      expect(terminal.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally {
      socket.close();
      replacement?.close();
    }
  });

  it('uses only the preflighted initial agent even when registered defaults have changed', async () => {
    const { fixture, session } = await seedBlockedAdmission({
      mode: 'architect',
      model: modelB,
      variant: 'low',
    });
    await expect(
      session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
        agent: { mode: 'reviewer', model: agentA.model },
        message: {
          initialTurn: { type: 'prompt', messageId: INITIAL_MESSAGE_ID, prompt: 'initial' },
        },
      })
    ).resolves.toMatchObject({ success: true });
    const state = await admissionState(session);
    expect(state.messages[1]?.intent).toEqual({
      turn: { type: 'prompt', messageId: INITIAL_MESSAGE_ID, prompt: 'initial' },
      agent: { mode: 'reviewer', model: agentA.model },
    });
    expect(state.metadata?.agent).toEqual({ mode: 'architect', model: agentA.model });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('permanently fails a legacy prompt without a model while a new command stays model-less after defaults change', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    const legacy: SessionMessageRecord = {
      messageId: 'msg_invalid_model',
      state: 'queued',
      prompt: 'never deliver',
      attachFailures: 1,
      promptFailures: 2,
    };
    try {
      const requests = captureAndAcceptControlRequests(socket);
      await session.registerSession({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
        agent: { mode: 'code' },
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
      });
      await runInDurableObject(session, (_instance, state) => {
        state.storage.kv.put('session_messages', [legacy]);
      });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_model_less', command: 'status', arguments: '--all' },
          agent: { mode: 'reviewer' },
        })
      ).resolves.toMatchObject({ success: true });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_selected', prompt: 'new B cannot rescue old input' },
          agent: { model: modelB },
        })
      ).resolves.toMatchObject({ success: true });
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await runInDurableObject(session, instance => instance.alarm());
      await waitForAccepted(session, 'msg_model_less');
      const delivered = await admissionState(session);
      expect(delivered.messages[0]).toEqual({
        ...legacy,
        state: 'failed',
        failedReason: 'invalid_model',
        legacyIntentInvalid: true,
        preparationAttemptId: expect.any(String),
        deliveryDeadlineAt: expect.any(Number),
        terminalAt: expect.any(Number),
      });
      expect(delivered.messages.slice(1)).toMatchObject([
        { messageId: 'msg_model_less', state: 'accepted' },
        { messageId: 'msg_selected', state: 'queued', intent: { agent: { model: modelB } } },
      ]);
      expect(delivered.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      await runInDurableObject(session, instance => instance.alarm());
      await runInDurableObject(session, instance => instance.alarm());
      expect(await admissionState(session)).toEqual(delivered);
      expect(requests.map(request => request.operation)).toEqual([
        'session.attach',
        'session.prompt',
      ]);
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: 'msg_model_less',
          turn: { type: 'command', command: 'status', arguments: '--all' },
          agent: { mode: 'reviewer' },
        },
      ]);
      await runInDurableObject(session, (_instance, state) => {
        const events = createEventQueries(
          drizzle(state.storage, { logger: false }),
          state.storage.sql
        ).findByFilters({ eventTypes: ['cloud.message.failed'] });
        expect(events.map(event => JSON.parse(event.payload))).toMatchObject([
          { messageId: 'msg_invalid_model', reason: 'invalid_model', accepted: false },
        ]);
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await session.interruptExecution();
      socket.close();
    }
  });

  it.each([
    {
      status: 200,
      body: { valid: false, reason: 'unavailable' },
      code: 'BAD_REQUEST',
      publicCode: 'BAD_REQUEST',
      error: 'Selected model is not available for this cloud agent session',
      retryable: false,
    },
    {
      status: 403,
      body: {},
      code: 'FORBIDDEN',
      publicCode: 'FORBIDDEN',
      error: 'Model catalog access denied for this cloud agent session',
      retryable: false,
    },
    {
      status: 503,
      body: {},
      code: 'MODEL_VALIDATION_UNAVAILABLE',
      publicCode: 'SERVICE_UNAVAILABLE',
      error: 'Model availability could not be verified',
      retryable: true,
    },
  ])(
    'preserves $code over real admission RPC without queue or metadata mutation',
    async outcome => {
      const { fixture, session } = await seedBlockedAdmission();
      await runInDurableObject(session, (_instance, state) => {
        const messages = state.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
        state.storage.kv.put('session_messages', [
          ...messages,
          { messageId: 'msg_legacy', state: 'queued', prompt: 'retain old format on rejection' },
        ] satisfies SessionMessageRecord[]);
      });
      const before = await admissionState(session);
      vi.mocked(globalThis.fetch).mockImplementation(async () =>
        Response.json(outcome.body, { status: outcome.status })
      );
      const result = await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_rejected', prompt: 'B' },
        agent: { model: modelB, mode: 'reviewer', variant: 'low' },
      });
      expect(result).toEqual({ success: false, code: outcome.code, error: outcome.error });
      expect(await admissionState(session)).toEqual(before);
      if (result.success) throw new Error('Expected model admission failure');
      expect(() => throwAdmissionError(result)).toThrowError(
        expect.objectContaining({
          code: outcome.publicCode,
          message: outcome.error,
          cause: expect.objectContaining({ error: outcome.code, retryable: outcome.retryable }),
        })
      );
      const [input, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe('/api/organizations/stored-org/models/validate');
      expect(request.headers.get('Authorization')).toBe('Bearer stored-test-token');
      expect(request.headers.get('X-KiloCode-OrganizationId')).toBe('stored-org');
      expect(request.headers.get('X-KiloCode-Feature')).toBe('stored-platform');
      expect(await request.json()).toEqual({ modelId: 'openai/gpt-4.1' });
    }
  );

  it('rejects an omitted prompt model without a stored default and does not mutate admission state', async () => {
    const { fixture, session } = await seedBlockedAdmission({ mode: 'code' });
    const before = await admissionState(session);
    await expect(
      session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_missing', prompt: 'missing selection' },
      })
    ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(await admissionState(session)).toEqual(before);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  function pauseNextValidation() {
    let entered = false;
    let released = false;
    let body: unknown;
    vi.mocked(globalThis.fetch).mockImplementationOnce(async (_input, init) => {
      body = init?.body;
      entered = true;
      while (!released) await new Promise(resolve => setTimeout(resolve, 1));
      return Response.json({ valid: true });
    });
    return {
      entered: async () => {
        await vi.waitFor(() => expect(entered).toBe(true));
        if (typeof body !== 'string') throw new Error('Expected validation request body');
        return JSON.parse(body) as unknown;
      },
      release: () => {
        released = true;
      },
    };
  }

  it('keeps the validated selection frozen while concurrent admission changes defaults and metadata', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const validation = pauseNextValidation();
    const pending = session.admitSubmittedMessage({
      userId: fixture.ownerId,
      turn: { type: 'prompt', id: 'msg_slow_a', prompt: 'resolved A before validation' },
    });
    try {
      expect(await validation.entered()).toEqual({ modelId: 'anthropic/claude-sonnet-4' });
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'command', id: 'msg_fast_b', command: 'review', arguments: '' },
        agent: { model: modelB, mode: 'reviewer', variant: 'low' },
      });
      await session.tryUpdate({ callbackTarget: { url: 'https://example.com/updated-callback' } });
      expect((await admissionState(session)).metadata?.agent).toEqual({
        mode: 'code',
        model: modelB,
        variant: 'low',
      });
      validation.release();
      await expect(pending).resolves.toMatchObject({ success: true });
      const state = await admissionState(session);
      expect(state.messages.slice(1).map(message => message.intent?.agent)).toEqual([
        { mode: 'reviewer', model: modelB, variant: 'low' },
        agentA,
      ]);
      expect(state.metadata?.agent).toEqual(agentA);
      expect(state.metadata?.callback).toEqual({
        target: { url: 'https://example.com/updated-callback' },
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      validation.release();
      await pending;
    }
  });

  it.each([
    { conflict: 'model', initialAgent: agentA, nextAgent: { model: modelB } },
    {
      conflict: 'absent variant',
      initialAgent: { mode: 'code', model: agentA.model },
      nextAgent: { model: agentA.model, variant: 'low' },
    },
  ])(
    'rechecks a concurrent duplicate with a different $conflict after validation',
    async ({ initialAgent, nextAgent }) => {
      const { fixture, session } = await seedBlockedAdmission(initialAgent);
      const validation = pauseNextValidation();
      const input: SubmittedSessionMessageRequest = {
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_concurrent', prompt: 'same submitted content' },
      };
      const pending = session.admitSubmittedMessage(input);
      try {
        await validation.entered();
        await session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'command', id: 'msg_change_default', command: 'review', arguments: '' },
          agent: nextAgent,
        });
        await expect(session.admitSubmittedMessage(input)).resolves.toMatchObject({
          success: true,
        });
        const winner = await admissionState(session);
        validation.release();
        await expect(pending).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
        expect(await admissionState(session)).toEqual(winner);
        expect(
          winner.messages.filter(message => message.messageId === 'msg_concurrent')
        ).toMatchObject([{ intent: { agent: nextAgent } }]);
      } finally {
        validation.release();
        await pending;
      }
    }
  );

  it('returns sent when a concurrent duplicate is accepted before validation completes without rewinding newer defaults', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    const validation = pauseNextValidation();
    let pending: ReturnType<SessionStub['admitSubmittedMessage']> | undefined;
    try {
      const requests = captureAndAcceptControlRequests(socket);
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await session.registerSession({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
      });
      const input: SubmittedSessionMessageRequest = {
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_winner', prompt: 'accepted concurrent winner' },
      };
      pending = session.admitSubmittedMessage(input);
      await validation.entered();
      await session.admitSubmittedMessage(input);
      await waitForAccepted(session, 'msg_winner');
      await session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'command', id: 'msg_new_defaults', command: 'review', arguments: '' },
        agent: { model: modelB },
      });
      const winner = await admissionState(session);
      validation.release();
      await expect(pending).resolves.toMatchObject({
        success: true,
        compatibilityDelivery: 'sent',
      });
      expect(await admissionState(session)).toEqual(winner);
      expect(winner.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      expect(requests.filter(request => request.operation === 'session.prompt')).toHaveLength(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    } finally {
      validation.release();
      await pending;
      socket.close();
    }
  });

  it('does not resurrect a duplicate message terminalized while validation is pending', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const validation = pauseNextValidation();
    const input: SubmittedSessionMessageRequest = {
      userId: fixture.ownerId,
      turn: { type: 'prompt', id: 'msg_terminal', prompt: 'cancel before validation returns' },
    };
    const pending = session.admitSubmittedMessage(input);
    try {
      await validation.entered();
      await session.admitSubmittedMessage(input);
      await session.markAsInterrupted();
      await session.interruptExecution();
      const terminal = await admissionState(session);
      validation.release();
      await expect(pending).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
      expect(await admissionState(session)).toEqual(terminal);
      expect(terminal.messages.find(message => message.messageId === 'msg_terminal')?.state).toBe(
        'cancelled'
      );
    } finally {
      validation.release();
      await pending;
    }
  });

  it('fences pending validation when the session is deleted', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const validation = pauseNextValidation();
    const pending = session.admitSubmittedMessage({
      userId: fixture.ownerId,
      turn: { type: 'prompt', id: 'msg_deleted_validation', prompt: 'do not recreate state' },
      agent: { model: modelB },
    });
    try {
      await validation.entered();
      await session.deleteSession();
      validation.release();
      await expect(pending).resolves.toEqual({
        success: false,
        code: 'NOT_FOUND',
        error: 'Session not found',
      });
      expect(await admissionState(session)).toEqual({ metadata: undefined, messages: [] });
      await expect(session.getMetadata()).resolves.toBeNull();
    } finally {
      validation.release();
      await pending;
    }
  });

  it('freezes both legacy queue formats before updating defaults and preserves history and retries', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const history: SessionMessageRecord[] = [
      ...(await admissionState(session)).messages,
      { messageId: 'msg_old_failed', state: 'failed', prompt: 'failed old content' },
    ];
    const legacy: SessionMessageRecord[] = [
      {
        messageId: 'msg_old_turn',
        state: 'queued',
        turn: { type: 'prompt', messageId: 'msg_old_turn', prompt: 'old turn A' },
        attachFailures: 1,
        promptFailures: 2,
        preparationAttemptId: 'attempt_old_turn',
      },
      { messageId: 'msg_old_prompt', state: 'queued', prompt: 'old prompt A' },
    ];
    await runInDurableObject(session, (_instance, state) => {
      state.storage.kv.put('session_messages', [...history, ...legacy]);
    });
    await expect(
      session.admitSubmittedMessage({
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: 'msg_new_b', prompt: 'new B' },
        agent: { model: modelB },
      })
    ).resolves.toMatchObject({ success: true });
    const frozen = await admissionState(session);
    expect(frozen.messages.slice(0, 2)).toEqual(history);
    expect(frozen.messages.slice(2).map(message => message.intent)).toEqual([
      { turn: { type: 'prompt', messageId: 'msg_old_turn', prompt: 'old turn A' }, agent: agentA },
      {
        turn: { type: 'prompt', messageId: 'msg_old_prompt', prompt: 'old prompt A' },
        agent: agentA,
      },
      {
        turn: { type: 'prompt', messageId: 'msg_new_b', prompt: 'new B' },
        agent: { mode: 'code', model: modelB },
      },
    ]);
    expect(frozen.messages[2]).toMatchObject({
      attachFailures: 1,
      promptFailures: 2,
      preparationAttemptId: 'attempt_old_turn',
    });
    expect(frozen.metadata?.agent).toEqual({ mode: 'code', model: modelB });
  });

  it('upgrades legacy queued delivery before awaiting control RPC even without new admission', async () => {
    const { fixture, session } = messageFixture();
    const { control, socket } = await initializeTerminalRuntime(fixture);
    let entered = false;
    let released = false;
    let dispatch: Promise<void> | undefined;
    try {
      const requests = captureAndAcceptControlRequests(socket);
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await session.registerSession({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
      });
      await runInDurableObject(session, (_instance, state) => {
        state.storage.kv.put('session_messages', [
          { messageId: 'msg_upgrade_a', state: 'queued', prompt: 'old A' },
        ] satisfies SessionMessageRecord[]);
      });
      await runInDurableObject(control, instance => {
        const prototype = Object.getPrototypeOf(instance) as typeof instance;
        const getStatus = instance.getStatus.bind(instance);
        vi.spyOn(prototype, 'getStatus').mockImplementationOnce(async () => {
          entered = true;
          while (!released) await new Promise(resolve => setTimeout(resolve, 1));
          return getStatus();
        });
      });
      dispatch = runInDurableObject(session, instance => instance.alarm());
      await vi.waitFor(() => expect(entered).toBe(true));
      expect((await admissionState(session)).messages[0]?.intent?.agent).toEqual(agentA);
      await runInDurableObject(session, async (instance, state) => {
        const metadata = await instance.getMetadata();
        if (!metadata) throw new Error('Expected registered metadata');
        state.storage.kv.put(
          'session_metadata',
          serializeSessionMetadata({ ...metadata, agent: { mode: 'architect', model: modelB } })
        );
      });
      released = true;
      await dispatch;
      await waitForAccepted(session, 'msg_upgrade_a');
      expect(
        requests
          .filter(request => request.operation === 'session.prompt')
          .map(request => request.payload)
      ).toEqual([
        {
          messageId: 'msg_upgrade_a',
          turn: { type: 'prompt', prompt: 'old A' },
          agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
        },
      ]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      released = true;
      await dispatch;
      socket.close();
    }
  });

  it('coalesces replays and alarms during a rejected handoff and retries the same intent once', async () => {
    const { fixture, session } = messageFixture();
    const { socket } = await initializeTerminalRuntime(fixture);
    const requests: RequestFrame[] = [];
    const entered = Promise.withResolvers<RequestFrame>();
    let holdFirstPrompt = true;
    let held: RequestFrame | undefined;
    let alarm: Promise<void> | undefined;
    try {
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      socket.addEventListener('message', event => {
        const request = requestFrameSchema.parse(JSON.parse(String(event.data)));
        requests.push(request);
        if (request.operation === 'session.prompt' && holdFirstPrompt) {
          holdFirstPrompt = false;
          held = request;
          entered.resolve(request);
          return;
        }
        acceptControlRequest(socket, request);
      });
      await session.createSessionWithInitialAdmission({
        identity: { sessionId: fixture.sessionId, userId: fixture.ownerId },
        auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
        agent: agentA,
        workspace: { sandboxId: fixture.sandboxId, workspacePath: '/workspace/terminal' },
        message: {
          initialTurn: { type: 'prompt', messageId: INITIAL_MESSAGE_ID, prompt: 'retry A' },
        },
      });
      const firstRequest = await entered.promise;
      const original = (await admissionState(session)).messages[0]?.intent;
      let alarmStarted = false;
      alarm = runInDurableObject(session, instance => {
        alarmStarted = true;
        return instance.alarm();
      });
      await vi.waitFor(() => expect(alarmStarted).toBe(true));
      const replay: SubmittedSessionMessageRequest = {
        userId: fixture.ownerId,
        turn: { type: 'prompt', id: INITIAL_MESSAGE_ID, prompt: 'retry A' },
      };
      await expect(
        Promise.all([session.admitSubmittedMessage(replay), session.admitSubmittedMessage(replay)])
      ).resolves.toMatchObject([
        { success: true, compatibilityDelivery: 'queued' },
        { success: true, compatibilityDelivery: 'queued' },
      ]);
      expect(requests.map(request => request.operation)).toEqual([
        'session.attach',
        'session.prompt',
      ]);
      socket.send(
        JSON.stringify({
          type: 'response',
          requestId: firstRequest.requestId,
          ok: false,
          error: { code: 'not_ready', message: 'Retry prompt delivery', retryable: true },
        })
      );
      held = undefined;
      await alarm;
      expect((await admissionState(session)).messages[0]).toMatchObject({
        state: 'queued',
        promptFailures: 1,
        intent: original,
      });
      await expect(
        session.admitSubmittedMessage({
          userId: fixture.ownerId,
          turn: { type: 'prompt', id: 'msg_retry_b', prompt: 'new B' },
          agent: { model: modelB },
        })
      ).resolves.toMatchObject({ success: true });
      await runInDurableObject(session, instance => instance.alarm());
      await waitForAccepted(session, INITIAL_MESSAGE_ID);
      await runInDurableObject(session, instance => instance.alarm());
      const delivered = requests.filter(request => request.operation === 'session.prompt');
      expect(delivered).toHaveLength(2);
      expect(delivered[0]?.payload).toEqual(delivered[1]?.payload);
      expect(delivered[1]?.payload).toEqual({
        messageId: INITIAL_MESSAGE_ID,
        turn: { type: 'prompt', prompt: 'retry A' },
        agent: { ...agentA, model: 'anthropic/claude-sonnet-4' },
      });
      const accepted = await admissionState(session);
      expect(accepted.messages).toMatchObject([
        { messageId: INITIAL_MESSAGE_ID, state: 'accepted', promptFailures: 1, intent: original },
        { messageId: 'msg_retry_b', state: 'queued' },
      ]);
      expect(accepted.metadata?.agent).toEqual({ mode: 'code', model: modelB });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      if (held) acceptControlRequest(socket, held);
      await alarm;
      await session.interruptExecution();
      socket.close();
    }
  });

  it('reconnects prompt and model-less command snapshots from nested intent', async () => {
    const { fixture, session } = await seedBlockedAdmission();
    const records: SessionMessageRecord[] = [
      createSessionMessageRecord({
        turn: { type: 'prompt', messageId: 'msg_v2_prompt', prompt: 'nested prompt' },
        agent: agentA,
      }),
      createSessionMessageRecord({
        turn: {
          type: 'command',
          messageId: 'msg_v2_command',
          command: 'review',
          arguments: '--all',
        },
        agent: { mode: 'code' },
      }),
    ];
    await runInDurableObject(session, (_instance, state) => {
      state.storage.kv.put('session_messages', records);
    });
    const response = await SELF.fetch(
      `http://worker.test/stream?sessionId=${fixture.sessionId}&userId=${fixture.ownerId}&replay=false`,
      { headers: { Upgrade: 'websocket' } }
    );
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) throw new Error('Expected session stream');
    const events: { streamEventType: string; data: unknown }[] = [];
    socket.addEventListener('message', event => {
      events.push(JSON.parse(String(event.data)));
    });
    socket.accept();
    try {
      await vi.waitFor(() => {
        expect(
          events
            .filter(event => event.streamEventType === 'cloud.message.queued')
            .map(event => event.data)
        ).toEqual([
          { messageId: 'msg_v2_prompt', content: 'nested prompt', delivery: 'queued' },
          { messageId: 'msg_v2_command', content: '/review --all', delivery: 'queued' },
        ]);
      });
      expect((await admissionState(session)).messages).toEqual(records);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      socket.close();
    }
  });

  it.each(['accepted', 'failed', 'accepted_overdue'] as const)(
    'detaches a deleted root with %s work while preserving its sibling and message-scoped interrupts',
    async messageState => {
      const userId = 'user_control_delete';
      const sessionId = GRANT_SESSION_ID;
      const siblingSessionId = SECOND_GRANT_SESSION_ID;
      const controlId = `usr-${crypto.randomUUID().replaceAll('-', '')}` as const;
      const wrapperInstanceId = crypto.randomUUID();
      const credential = generateSandboxCredential();
      const control = env.SANDBOX_CONTROL.getByName(controlId);
      const { provider } = await installProvider(control, cloudflareRef(controlId));
      await runInDurableObject(control, async (instance, state) => {
        await instance.initializeOwner(userId);
        await seedRunningCloudflare(instance);
        await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
        await attachGrantedSession(instance, state, groupedRoute(sessionId, ROOT_ID, userId));
        await attachGrantedSession(
          instance,
          state,
          groupedRoute(siblingSessionId, SECOND_ROOT_ID, userId)
        );
        const routes = await loadRouteTable(state.storage);
        for (const kiloSessionId of [ROOT_ID, SECOND_ROOT_ID]) {
          applyReportedSessionState(
            routes,
            kiloSessionId,
            { state: 'active', idleForMs: 0 },
            Date.now()
          );
        }
        await saveRouteTable(state.storage, routes);
      });

      const session = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
      await runInDurableObject(session, async (instance, state) => {
        await instance.registerSession({
          identity: { sessionId, userId },
          auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
          agent: { mode: 'code', model: 'test' },
          workspace: {
            sandboxId: controlId,
            workspacePath: '/workspace/shared',
            worktreeId: WORKTREE_ID,
          },
        });
        const acceptedAt = messageState === 'accepted_overdue' ? 1 : Date.now();
        await state.storage.put('session_messages', [
          {
            messageId: 'msg_deleted',
            state: messageState === 'accepted' ? 'accepted' : 'failed',
            ...(messageState === 'accepted_overdue' ? { failedReason: 'accepted_overdue' } : {}),
            wrapperInstanceId,
            acceptedAt,
            lastActivityAt: acceptedAt,
          } satisfies SessionMessageRecord,
        ]);
        if (messageState !== 'accepted') {
          await expect(instance.getCurrentMessageWork()).resolves.toBeNull();
        }
      });

      const ws = await connect(credential, controlId);
      await completeHello(ws, 'hello-shared-delete', {
        providerInstanceId: cloudflareRef(controlId),
        wrapperInstanceId,
      });
      signalWrapperReady(ws);
      await vi.waitFor(async () => {
        await expect(control.getStatus()).resolves.toMatchObject({ connection: 'ready' });
      });
      ws.send(
        JSON.stringify({
          type: 'event',
          event: 'sandbox.heartbeat',
          payload: {
            state: 'active',
            kilo: { ready: true },
            sessions: [ROOT_ID, SECOND_ROOT_ID].map(kiloSessionId => ({
              kiloSessionId,
              state: 'active',
              idleForMs: 0,
            })),
          },
        })
      );
      await vi.waitFor(async () => {
        await runInDurableObject(control, async (_instance, state) => {
          expect((await loadDeadlines(state.storage)).idleStop).toBeUndefined();
        });
      });
      const lifecycleRequests: {
        operation: string;
        session: { sessionId: string; kiloSessionId: string; directory: string };
      }[] = [];
      ws.addEventListener('message', event => {
        const request = JSON.parse(String(event.data)) as {
          operation?: string;
          requestId: string;
          session: { sessionId: string; kiloSessionId: string; directory: string };
        };
        if (request.operation !== 'session.abort' && request.operation !== 'session.detach') return;
        lifecycleRequests.push({ operation: request.operation, session: request.session });
        ws.send(
          JSON.stringify({
            type: 'response',
            requestId: request.requestId,
            ok: true,
            result:
              request.operation === 'session.abort' ? { status: 'aborted' } : { detached: true },
          })
        );
      });

      await runInDurableObject(session, instance => instance.deleteSession());
      await runInDurableObject(control, async (instance, state) => {
        await expect(instance.listRoutes()).resolves.toEqual([
          expect.objectContaining({
            sessionId: siblingSessionId,
            kiloSessionId: SECOND_ROOT_ID,
            lastState: 'active',
          }),
        ]);
        await expect(instance.getPhysicalRecord()).resolves.toMatchObject({ state: 'running' });
        expect((await loadDeadlines(state.storage)).idleStop).toBeUndefined();
        expect(
          (await loadSessionCredentialGrants(state.storage)).flatMap(grant => grant.members)
        ).toEqual([{ sessionId: siblingSessionId, kiloSessionId: SECOND_ROOT_ID }]);
      });
      await runInDurableObject(session, async instance => {
        await expect(instance.getMetadata()).resolves.toBeNull();
      });
      const operations =
        messageState === 'accepted' ? ['session.abort', 'session.detach'] : ['session.detach'];
      expect(lifecycleRequests).toEqual(
        operations.map(operation => ({
          operation,
          session: { sessionId, kiloSessionId: ROOT_ID, directory: '/workspace/shared' },
        }))
      );
      expect(provider.stop).not.toHaveBeenCalled();
      expect(provider.create).not.toHaveBeenCalled();
      ws.close();
    }
  );

  it('preserves repository branches and structured initial and follow-up command turns', async () => {
    const userId = 'user_control_commands' as const;
    const sessionId = 'workspace_control_commands';
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
    await runInDurableObject(stub, async (instance, state) => {
      const blocker = {
        messageId: 'msg_blocker',
        state: 'accepted',
        acceptedAt: 1,
        lastActivityAt: 1,
      } satisfies SessionMessageRecord;
      await state.storage.put('session_messages', [blocker]);

      const repository = {
        type: 'github',
        repo: 'acme/demo',
        branch: 'feature/commands',
      } as const;
      const initialTurn = {
        type: 'command',
        messageId: INITIAL_MESSAGE_ID,
        command: 'review',
        arguments: '--all changes',
      } as const;
      await expect(
        instance.createSessionWithInitialAdmission({
          identity: { sessionId, userId },
          auth: { kiloSessionId: 'kilo_root' },
          agent: { mode: 'code', model: 'test' },
          repository,
          message: { initialTurn },
        })
      ).resolves.toMatchObject({ success: true, messageId: initialTurn.messageId });
      await expect(instance.getMetadata()).resolves.toMatchObject({
        repository: {
          type: 'github',
          repo: repository.repo,
          upstreamBranch: repository.branch,
        },
      });

      const followUpTurn = {
        type: 'command',
        id: 'msg_followup_command',
        command: 'compact',
        arguments: '--aggressive',
      } as const;
      await expect(
        instance.admitSubmittedMessage({ userId, turn: followUpTurn })
      ).resolves.toMatchObject({ success: true, messageId: followUpTurn.id });
      expect(await state.storage.get<SessionMessageRecord[]>('session_messages')).toEqual([
        blocker,
        createSessionMessageRecord({
          turn: initialTurn,
          agent: { mode: 'code', model: 'test' },
        }),
        createSessionMessageRecord({
          turn: {
            type: 'command',
            messageId: followUpTurn.id,
            command: followUpTurn.command,
            arguments: followUpTurn.arguments,
          },
          agent: { mode: 'code', model: 'test' },
        }),
      ]);
    });
  });

  it.each(['session.turn.close', 'session.error'])(
    'preserves parent work and the persisted child %s event',
    async eventType => {
      const userId = 'user_control_child';
      const sessionId = `workspace_control_child_${eventType.replaceAll('.', '_')}`;
      const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);
      const wrapperInstanceId = crypto.randomUUID();
      await runInDurableObject(stub, async (instance, state) => {
        await instance.registerSession({
          identity: { sessionId, userId },
          auth: { kiloSessionId: 'kilo_root' },
          agent: { mode: 'code', model: 'test' },
          workspace: { workspacePath: '/workspace/root' },
        });
        const accepted = {
          messageId: 'msg_parent',
          state: 'accepted',
          wrapperInstanceId,
          acceptedAt: 1,
          lastActivityAt: 2,
          turn: { type: 'prompt', messageId: 'msg_parent', prompt: 'parent turn' },
        } satisfies SessionMessageRecord;
        const queued = {
          messageId: 'msg_next',
          state: 'queued',
          turn: { type: 'command', messageId: 'msg_next', command: 'status', arguments: '' },
        } satisfies SessionMessageRecord;
        await state.storage.put('session_messages', [accepted, queued]);

        const observedAt = Date.now();
        await expect(
          instance.receiveSandboxControlEvent({
            identity: {
              directory: '/workspace/root',
              kiloSessionId: 'kilo_child',
              rootKiloSessionId: 'kilo_root',
            },
            payload: { type: eventType, properties: { sessionID: 'kilo_child' } },
            wrapperInstanceId,
          })
        ).resolves.toEqual({ applied: true });

        const messages = await state.storage.get<SessionMessageRecord[]>('session_messages');
        expect(messages).toEqual([{ ...accepted, lastActivityAt: expect.any(Number) }, queued]);
        expect(messages?.[0]?.lastActivityAt).toBeGreaterThanOrEqual(observedAt);
        await expect(instance.getCurrentMessageWork()).resolves.toEqual({
          messageId: accepted.messageId,
          status: 'running',
          health: 'healthy',
        });

        const events = createEventQueries(
          drizzle(state.storage, { logger: false }),
          state.storage.sql
        ).findByFilters({ eventTypes: ['kilocode'] });
        expect(events.map(event => JSON.parse(event.payload))).toEqual([
          {
            type: eventType,
            event: eventType,
            properties: { sessionID: 'kilo_child' },
          },
        ]);
      });
    }
  );
});

describe('SandboxControl terminal runtime coordination', () => {
  it('reuses one billed allocation for sibling roots and authorizes their terminals without weakening payer, actor, or physical identity', async () => {
    const { control, registration, sandboxId } = await credentialFixture(
      'cloudflare',
      'ses-b111ed'
    );
    const { provider } = await installProvider(control);
    const sibling: CredentialRegistration = {
      ...registration,
      identity: { ...registration.identity, sessionId: SECOND_GRANT_SESSION_ID },
      auth: { ...registration.auth, kiloSessionId: SECOND_ROOT_ID },
    };
    await registerCredentialSession(sibling);
    const organizationId = registration.identity.orgId;
    if (!organizationId) throw new Error('Missing fixture payer');
    const billing: SandboxBillingInput = {
      sandboxId,
      subject: { type: 'org', id: organizationId },
      actor: { type: 'user', id: registration.identity.userId },
      sessionId: registration.identity.sessionId,
      enforcementRequested: true,
    };
    const first = await control.ensureReady({
      ...credentialInput(registration),
      allowCreate: true,
      billing,
    });
    const physical = await control.getPhysicalRecord();
    const second = await control.ensureReady({
      ...credentialInput(sibling),
      allowCreate: false,
      billing: { ...billing, sessionId: sibling.identity.sessionId },
    });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.launch).toHaveBeenCalledTimes(1);
    expect(provider.create.mock.calls[0]?.[0].billing).toMatchObject({
      ...billing,
      sessionId: GRANT_SESSION_ID,
    });
    expect(provider.ensureBillingAdmission).toHaveBeenCalledWith(physical.providerRef, {
      ...billing,
      sessionId: GRANT_SESSION_ID,
    });
    expect(await control.getPhysicalRecord()).toEqual(physical);
    for (const change of [
      { subject: { type: 'org', id: 'other-org' } },
      { actor: { type: 'bot', id: 'other-bot' }, onBehalfOf: billing.subject },
    ] as const) {
      const rejected = control
        .ensureReady({
          ...credentialInput(sibling),
          allowCreate: false,
          billing: { ...billing, ...change, sessionId: sibling.identity.sessionId },
        })
        .then(
          () => null,
          (error: unknown) => error
        );
      expect(await rejected).toMatchObject({ message: 'Sandbox billing allocation mismatch' });
    }
    if (!first.attachment || !second.attachment) throw new Error('Missing sibling attachments');
    await control.attachSession(attachInput(registration, first.attachment));
    await control.attachSession(attachInput(sibling, second.attachment));
    const launch = provider.launch.mock.calls[0];
    const native = decodeCloudflareProviderRef(physical.providerRef);
    if (!launch || !native) throw new Error('Missing billed physical allocation');
    const wrapperInstanceId = crypto.randomUUID();
    const socket = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, sandboxId);
    try {
      await completeHello(socket, 'hello-billed-siblings', {
        providerInstanceId: launch[0],
        wrapperInstanceId,
      });
      signalWrapperReady(socket);
      await vi.waitFor(async () => {
        await expect(control.getStatus()).resolves.toMatchObject({ connection: 'ready' });
      });
      await runInDurableObject(control, async instance => {
        const namespace = instance['env'].SandboxSmallContainment;
        const context: BillingContext = {
          service: 'cloud-agent-next-sandbox-small-containment',
          instanceId: native.sandboxId,
          sku: SANDBOX_USAGE_SKUS.SandboxSmallContainment,
          subject: billing.subject,
          actor: billing.actor,
          sessionId: GRANT_SESSION_ID,
          metadata: {
            container_class: 'SandboxSmallContainment',
            durable_object_id: namespace.idFromName(native.sandboxId).toString(),
          },
          startEpochMs: Date.now(),
          generation: crypto.randomUUID(),
          measurementStarted: true,
          nextSeq: 1,
          usageMeasuredAtMs: Date.now(),
        };
        let measured = context;
        const get = namespace.get.bind(namespace);
        vi.spyOn(namespace, 'get').mockImplementation(id =>
          Object.assign(get(id), {
            getBillingRuntimeStatus: async () => ({
              sandboxClassName: 'SandboxSmallContainment',
              running: true,
              blocked: false,
              context: measured,
            }),
          })
        );
        Object.assign(instance['env'], {
          CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
          CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS: organizationId,
        });
        for (const member of [registration, sibling]) {
          const access = { ...credentialInput(member), organizationId, wrapperInstanceId };
          await expect(instance.validateTerminalAccess(access)).resolves.toEqual({ allowed: true });
          await expect(instance.recordTerminalActivity(access)).resolves.toEqual({ allowed: true });
          for (const [change, reason] of [
            [{ subject: { type: 'org', id: 'other-org' } }, 'billing_payer_mismatch'],
            [{ actor: { type: 'user', id: 'other-user' } }, 'billing_actor_mismatch'],
            [{ instanceId: 'ses-f0e1' }, 'billing_runtime_mismatch'],
            [{ sessionId: SECOND_GRANT_SESSION_ID }, 'billing_session_mismatch'],
          ] as const) {
            measured = { ...context, ...change };
            await expect(instance.validateTerminalAccess(access)).resolves.toEqual({
              allowed: false,
              reason,
            });
          }
          measured = context;
        }
      });
      expect(provider.create).toHaveBeenCalledTimes(1);
      expect(provider.launch).toHaveBeenCalledTimes(1);
    } finally {
      socket.close();
    }
  });

  it.each(['cloudflare', 'vercel'] as const)(
    'renews near-expiry and expired %s grants through authenticated terminal activity',
    async provider => {
      const fixture = await credentialTerminalFixture(provider);
      const { control, access, socket, vercel } = fixture;
      try {
        for (const remainingMs of [HOUR / 2, -1_000]) {
          const [original] = await storedGrants(control);
          if (!original) throw new Error('Missing terminal credential grant');
          const now = Date.now();
          const aged = {
            ...original,
            preparedAt: now + remainingMs - 4 * HOUR,
            expiresAt: now + remainingMs,
          };
          await runInDurableObject(control, async (_instance, state) => {
            await saveSessionCredentialGrants(state.storage, [aged]);
            if (provider === 'vercel') {
              await state.storage.put('deadlines', { credentialExpiry: aged.expiresAt });
            }
          });
          const exportUrl = `${CONTAINMENT_TARGETS.sessionIngestBaseUrl}/api/session/${ROOT_ID}/export`;
          if (remainingMs < 0) {
            if (provider === 'vercel') {
              await runCredentialExpiryAlarm(control);
              expect(
                policyAuthorization(vercel.runtime.policy, original.kilo.alias, exportUrl)
              ).toBeUndefined();
            } else {
              await expect(
                control.resolveCredential({
                  credential: original.kilo.alias,
                  outboundContainerId: original.outboundContainerId ?? '',
                  url: exportUrl,
                  method: 'GET',
                })
              ).resolves.toBeNull();
            }
          }
          const physical = await control.getPhysicalRecord();
          await expect(
            Promise.all([
              control.recordTerminalActivity(access),
              control.validateTerminalAccess(access),
            ])
          ).resolves.toEqual([{ allowed: true }, { allowed: true }]);
          const renewed = await storedGrants(control);
          expect(renewed).toHaveLength(1);
          expect(renewed[0]).toMatchObject({
            scopeId: original.scopeId,
            members: original.members,
            kilo: { alias: original.kilo.alias },
            scm: { alias: original.scm?.alias },
          });
          expect(renewed[0].expiresAt).toBeGreaterThan(now + 3 * HOUR);
          expect(await control.getPhysicalRecord()).toEqual(physical);
          await expect(control.validateTerminalAccess(access)).resolves.toEqual({ allowed: true });
          expect(await storedGrants(control)).toEqual(renewed);
          if (provider === 'vercel') {
            expect(policyAuthorization(vercel.runtime.policy, original.kilo.alias, exportUrl)).toBe(
              `Bearer ${KILO_TOKEN}`
            );
            expect(await credentialExpiryDeadline(control)).toBe(renewed[0].expiresAt);
          }
        }
        expect(
          provider === 'vercel' ? vercel.runtime.creates : fixture.containers.launches.length
        ).toBe(1);
      } finally {
        socket.close();
      }
    }
  );

  it.each(['missing', 'owner-changed', 'revoked'] as const)(
    'does not renew terminal credentials when authoritative session metadata is %s',
    async kind => {
      const { control, access, socket, session } = await credentialTerminalFixture('cloudflare');
      try {
        const now = Date.now();
        await runInDurableObject(control, async (_instance, state) => {
          const grants = await loadSessionCredentialGrants(state.storage);
          await saveSessionCredentialGrants(
            state.storage,
            grants.map(grant => ({
              ...grant,
              preparedAt: now - 3.5 * HOUR,
              expiresAt: now + HOUR / 2,
            }))
          );
        });
        const grants = await storedGrants(control);
        await runInDurableObject(session, async (instance, state) => {
          const metadata = await instance.getCredentialMetadata();
          if (!metadata) throw new Error('Missing terminal session metadata');
          if (kind === 'missing') {
            state.storage.kv.delete(SANDBOX_SESSION_METADATA_KEY);
          } else if (kind === 'owner-changed') {
            state.storage.kv.put(
              SANDBOX_SESSION_METADATA_KEY,
              serializeSessionMetadata({
                ...metadata,
                identity: { ...metadata.identity, userId: 'another-owner' },
              })
            );
          } else {
            state.storage.kv.put(SANDBOX_SESSION_LIFECYCLE_KEY, { epoch: 1, state: 'revoked' });
          }
        });
        await expect(control.recordTerminalActivity(access)).resolves.toEqual({
          allowed: false,
          reason: 'credential_scope_unavailable',
        });
        expect(await storedGrants(control)).toEqual(grants);
      } finally {
        socket.close();
      }
    }
  );

  it.each(['runtime', 'route', 'membership'] as const)(
    'does not publish terminal renewal when %s changes during credential issuance',
    async changed => {
      const { control, access, socket, broker, sandboxId } =
        await credentialTerminalFixture('cloudflare');
      try {
        await runInDurableObject(control, async (instance, state) => {
          const now = Date.now();
          const grants = (await loadSessionCredentialGrants(state.storage)).map(grant => ({
            ...grant,
            preparedAt: now - 3.5 * HOUR,
            expiresAt: now + HOUR / 2,
            kilo: {
              ...grant.kilo,
              capabilities: Object.fromEntries(
                Object.entries(grant.kilo.capabilities).map(([id, capability]) => [
                  id,
                  { ...capability, issuedAt: now - 4 * HOUR, expiresAt: now - HOUR },
                ])
              ),
            },
          }));
          await saveSessionCredentialGrants(state.storage, grants);
          const issue = broker.binding.issueKiloSessionCapability.bind(broker.binding);
          broker.binding.issueKiloSessionCapability = async subject => {
            if (changed === 'runtime') {
              await state.storage.put(
                'physical_record',
                containedRunningRecord(cloudflareRef(sandboxId, 'replacement'))
              );
            } else if (changed === 'route') {
              await state.storage.put('session_routes', []);
            } else {
              await saveSessionCredentialGrants(state.storage, []);
            }
            return issue(subject);
          };
          await expect(instance.recordTerminalActivity(access)).resolves.toEqual({
            allowed: false,
            reason: 'credential_scope_unavailable',
          });
          expect(await loadSessionCredentialGrants(state.storage)).toEqual(
            changed === 'membership' ? [] : grants
          );
        });
      } finally {
        socket.close();
      }
    }
  );

  it('exposes a wrapper instance only for the ready current connection', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a001',
      ownerId: 'owner_wrapper_readiness',
      sessionId: GRANT_SESSION_ID,
      wrapperInstanceId: 'b40b8d7b-789f-4c2a-82ce-0c5c9aed4621',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);

    await runInDurableObject(control, async instance => {
      const status = await instance.getStatus();
      expect(status).toMatchObject({ physical: 'running', connection: 'connected' });
      expect(status).not.toHaveProperty('wrapperInstanceId');
    });

    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);
    await runInDurableObject(control, async (_instance, state) => {
      const persisted = await state.storage.get<{
        connectionId: string;
        readyConnectionId?: string;
        wrapperInstanceId?: string;
      }>('active_wrapper_runtime');
      expect(persisted).toMatchObject({ wrapperInstanceId: fixture.wrapperInstanceId });
      expect(persisted?.readyConnectionId).toBe(persisted?.connectionId);
    });

    const rotatedCredential = generateSandboxCredential();
    await seedCredential(rotatedCredential, fixture.sandboxId);
    const replacement = await connect(rotatedCredential, fixture.sandboxId);
    await completeHello(replacement, 'hello_rotated_wrapper', {
      providerInstanceId: cloudflareRef(fixture.sandboxId),
      wrapperInstanceId: fixture.wrapperInstanceId,
    });
    await runInDurableObject(control, async (instance, state) => {
      const status = await instance.getStatus();
      expect(status.connection).toBe('connected');
      expect(status).not.toHaveProperty('wrapperInstanceId');
      expect(
        await state.storage.get<{ readyConnectionId?: string }>('active_wrapper_runtime')
      ).not.toHaveProperty('readyConnectionId');
      expect(await state.storage.get('wrapper_ready_at')).toBeUndefined();
      expect(await state.storage.get('deadlines')).not.toHaveProperty('heartbeatExpiry');
    });

    signalWrapperReady(replacement);
    await waitForWrapperReady(fixture);
    replacement.close();
  });

  it('preserves ready chat for older wrappers without granting terminal capability', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a002',
      ownerId: 'owner_legacy_wrapper',
      sessionId: GRANT_SESSION_ID,
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async instance => {
      const status = await instance.getStatus();
      expect(status).toMatchObject({ physical: 'running', connection: 'ready' });
      expect(status).not.toHaveProperty('wrapperInstanceId');
      await expect(
        instance.validateTerminalAccess({
          sessionId: fixture.sessionId,
          ownerId: fixture.ownerId,
          wrapperInstanceId: '27cbf2d6-aeef-42d0-8992-1a61e83e95a5',
        })
      ).resolves.toEqual({ allowed: false, reason: 'terminal_not_supported' });
    });
    socket.close();
  });

  it('validates the current session route, owner, and wrapper incarnation', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a003',
      ownerId: 'owner_terminal_access',
      sessionId: GRANT_SESSION_ID,
      wrapperInstanceId: '22c38b5a-5394-4a71-9c88-e3e998565fdb',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    const detached = nextMessage(socket).then(message => {
      const request = JSON.parse(message) as WrapperRequest;
      expect(request).toMatchObject({
        operation: 'session.detach',
        session: { sessionId: fixture.sessionId },
      });
      respondToWrapperRequest(socket, request, { detached: true });
    });
    await runInDurableObject(control, async instance => {
      const input = {
        sessionId: fixture.sessionId,
        ownerId: fixture.ownerId,
        wrapperInstanceId: fixture.wrapperInstanceId ?? '',
      };
      await expect(instance.validateTerminalAccess(input)).resolves.toEqual({ allowed: true });
      await expect(
        instance.validateTerminalAccess({ ...input, ownerId: 'owner_other' })
      ).resolves.toEqual({ allowed: false, reason: 'owner_mismatch' });
      await expect(
        instance.validateTerminalAccess({ ...input, sessionId: 'workspace_other' })
      ).resolves.toEqual({ allowed: false, reason: 'session_not_attached' });
      await expect(
        instance.validateTerminalAccess({
          ...input,
          wrapperInstanceId: 'd4e4d7ee-4456-4038-b64d-a564e96e054d',
        })
      ).resolves.toEqual({ allowed: false, reason: 'wrapper_instance_mismatch' });
      await expect(instance.detachSession(fixture.sessionId)).resolves.toEqual({ existed: true });
      await expect(instance.validateTerminalAccess(input)).resolves.toEqual({
        allowed: false,
        reason: 'session_not_attached',
      });
    });
    await detached;
    socket.close();
  });

  it('never provisions or wakes a stopped runtime for terminal access or activity', async () => {
    const control = env.SANDBOX_CONTROL.getByName('usr-a00a');
    const input = {
      sessionId: GRANT_SESSION_ID,
      ownerId: 'owner_stopped_access',
      wrapperInstanceId: '594b4020-64a5-42d4-bcf0-7915af4a099d',
    };

    await runInDurableObject(control, async (instance, state) => {
      await instance.initializeOwner(input.ownerId);
      const attachment = {
        sessionId: input.sessionId,
        kiloSessionId: ROOT_ID,
        directory: '/workspace/terminal',
        ownerId: input.ownerId,
      };
      await seedGrant(instance, state, attachment);
      const routes = await loadRouteTable(state.storage);
      attachRoute(routes, attachment, input.ownerId);
      await saveRouteTable(state.storage, routes);
      await expect(instance.validateTerminalAccess(input)).resolves.toEqual({
        allowed: false,
        reason: 'runtime_not_running',
      });
      await expect(instance.recordTerminalActivity(input)).resolves.toEqual({
        allowed: false,
        reason: 'runtime_not_running',
      });
      await expect(instance.getPhysicalRecord()).resolves.toMatchObject({
        state: 'stopped',
        providerRef: null,
        createIntent: null,
      });
    });
  });

  it.each(['same', 'different'] as const)(
    'ends PTYs after control replacement by the %s wrapper and fences late invalidation',
    async replacementIdentity => {
      const fixture: TerminalRuntimeFixture = {
        sandboxId: 'usr-a004',
        ownerId: 'owner_runtime_replacement',
        sessionId: GRANT_SESSION_ID,
        wrapperInstanceId: '2ece7e1a-6f7f-40b3-a4d8-307304eaaf93',
      };
      const { control, credential, socket, provider } = await initializeTerminalRuntime(fixture);
      const session = await seedTerminalSession(fixture);
      let newWrapper: WebSocket | undefined;
      signalWrapperReady(socket);
      await waitForWrapperReady(fixture);
      await runInDurableObject(session, (_instance, state) => {
        expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
          state: 'running',
        });
      });
      const sameWrapper = await connect(credential, fixture.sandboxId);
      try {
        const replaced = new Promise<number>(resolve => {
          sameWrapper.addEventListener('close', event => resolve(event.code), { once: true });
        });
        sendHello(sameWrapper, 'hello_replaced_runtime', {
          providerInstanceId: cloudflareRef(fixture.sandboxId),
          wrapperInstanceId:
            replacementIdentity === 'same' ? fixture.wrapperInstanceId : crypto.randomUUID(),
        });
        await expect(replaced).resolves.toBe(4001);
        await vi.waitFor(async () => {
          await expect(control.getPhysicalRecord()).resolves.toMatchObject({ state: 'stopped' });
          await runInDurableObject(session, (_instance, state) => {
            expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
              state: 'ended',
            });
            expect(state.storage.kv.get('terminal_attached_session')).toBeUndefined();
          });
        });
        expect(provider.stop).toHaveBeenCalledTimes(1);
        await control.ensureReady({
          ownerId: fixture.ownerId,
          sessionId: fixture.sessionId,
          allowCreate: true,
        });
        const launch = provider.launch.mock.calls[0];
        if (!launch) throw new Error('Expected replacement wrapper launch');
        expect(launch[0]).not.toBe(cloudflareRef(fixture.sandboxId));
        const replacementFixture = { ...fixture, wrapperInstanceId: crypto.randomUUID() };
        newWrapper = await connect(launch[1].SANDBOX_CONTROL_CREDENTIAL, fixture.sandboxId);
        await completeHello(newWrapper, 'hello_post_replacement_runtime', {
          providerInstanceId: launch[0],
          wrapperInstanceId: replacementFixture.wrapperInstanceId,
        });
        expect(await control.getStatus()).not.toHaveProperty('wrapperInstanceId');
        signalWrapperReady(newWrapper);
        await waitForWrapperReady(replacementFixture);
        await seedTerminalSession(replacementFixture, 'pty_current');
        await runInDurableObject(session, async (instance, state) => {
          await instance.invalidateTerminalRuntime({
            sandboxId: fixture.sandboxId,
            wrapperInstanceId: fixture.wrapperInstanceId ?? '',
            confirmed: true,
          });
          expect(state.storage.kv.get<{ state: string }>('terminal:pty_current')).toMatchObject({
            state: 'running',
          });
          expect(state.storage.kv.get('terminal_attached_session')).toMatchObject({
            wrapperInstanceId: replacementFixture.wrapperInstanceId,
          });
        });
        await expect(
          control.validateTerminalAccess({
            ownerId: fixture.ownerId,
            sessionId: fixture.sessionId,
            wrapperInstanceId: replacementFixture.wrapperInstanceId,
          })
        ).resolves.toEqual({ allowed: true });
      } finally {
        socket.close();
        sameWrapper.close();
        newWrapper?.close();
      }
    }
  );

  it('keeps PTY ownership on uncertain physical observations', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a005',
      ownerId: 'owner_uncertain_runtime',
      sessionId: GRANT_SESSION_ID,
      wrapperInstanceId: '6d1a1a6c-1153-4856-b07b-58b5b4f245aa',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async instance => {
      await expect(instance.observeProvider('unknown')).resolves.toMatchObject({
        state: 'unknown',
      });
      expect(await instance.getStatus()).not.toHaveProperty('wrapperInstanceId');
    });
    await runInDurableObject(session, (_instance, state) => {
      expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
        state: 'running',
      });
    });
    socket.close();
  });

  it('revokes terminal access on runtime failure and ends PTYs after confirmed cleanup', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a008',
      ownerId: 'owner_failed_runtime',
      sessionId: GRANT_SESSION_ID,
      wrapperInstanceId: '84114e6b-77c0-4792-88b9-2db90d789fe1',
    };
    const { control, socket, provider } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async instance => {
      await expect(instance.markFailed()).resolves.toMatchObject({ state: 'failed' });
      expect(await instance.getStatus()).not.toHaveProperty('wrapperInstanceId');
      await expect(
        instance.validateTerminalAccess({
          ownerId: fixture.ownerId,
          sessionId: fixture.sessionId,
          wrapperInstanceId: fixture.wrapperInstanceId ?? '',
        })
      ).resolves.toEqual({ allowed: false, reason: 'runtime_not_running' });
      await expect(instance.recordStopAttempt()).resolves.toMatchObject({ state: 'stopped' });
    });
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(provider.stop.mock.calls[0]?.[0]).toBe(cloudflareRef(fixture.sandboxId));
    await vi.waitFor(async () => {
      await runInDurableObject(session, (_instance, state) => {
        expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
          state: 'ended',
        });
      });
    });
  });

  it('invalidates active PTYs when a physical stop is confirmed', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a009',
      ownerId: 'owner_stopped_runtime',
      sessionId: GRANT_SESSION_ID,
      wrapperInstanceId: '78de88a1-a906-4e4f-bd9e-2447c21e6472',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await runInDurableObject(control, async instance => {
      await instance.beginStop('test');
      await expect(instance.confirmStopped()).resolves.toMatchObject({ state: 'stopped' });
      expect(await instance.getStatus()).not.toHaveProperty('wrapperInstanceId');
    });
    await vi.waitFor(async () => {
      await runInDurableObject(session, (_instance, state) => {
        expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
          state: 'ended',
        });
      });
    });
  });

  it('invalidates active PTYs when wrapper credentials rotate', async () => {
    const fixture: TerminalRuntimeFixture = {
      sandboxId: 'usr-a006',
      ownerId: 'owner_credential_rotation',
      sessionId: GRANT_SESSION_ID,
      wrapperInstanceId: 'bf73c60f-fd06-43f1-a93e-3412790a5ca4',
    };
    const { control, socket } = await initializeTerminalRuntime(fixture);
    const session = await seedTerminalSession(fixture);
    signalWrapperReady(socket);
    await waitForWrapperReady(fixture);

    await seedCredential(generateSandboxCredential(), fixture.sandboxId);
    await runInDurableObject(session, (_instance, state) => {
      expect(state.storage.kv.get<{ state: string }>('terminal:pty_original')).toMatchObject({
        state: 'ended',
      });
    });
    await runInDurableObject(control, async instance => {
      expect(await instance.getStatus()).not.toHaveProperty('wrapperInstanceId');
    });
  });

  it.each(['cloudflare', 'vercel'] as const)(
    'extends idle deadlines monotonically for authorized terminal activity on %s',
    async sandboxProvider => {
      const fixture: TerminalRuntimeFixture = {
        sandboxId: sandboxProvider === 'vercel' ? 'ses-a007' : 'usr-a007',
        sandboxProvider,
        ownerId: 'owner_terminal_activity',
        sessionId: GRANT_SESSION_ID,
        wrapperInstanceId: '5d1e54ed-31db-4646-a478-4864e87162c3',
      };
      const { control, socket, provider, providerRef } = await initializeTerminalRuntime(fixture);
      const clock = vi.spyOn(Date, 'now');
      try {
        signalWrapperReady(socket);
        await waitForWrapperReady(fixture);
        const now = Date.now();
        clock.mockReturnValue(now);
        provider.ensureLeaseAtLeast.mockClear();
        const activity = {
          sessionId: fixture.sessionId,
          ownerId: fixture.ownerId,
          wrapperInstanceId: fixture.wrapperInstanceId ?? '',
        };
        await runInDurableObject(control, async (instance, state) => {
          const current = await loadDeadlines(state.storage);
          const idleStop = now + 1_000;
          const before = { ...current, idleStop };
          await saveDeadlines(state.storage, before);
          await state.storage.setAlarm(idleStop);
          await expect(
            instance.recordTerminalActivity({
              ...activity,
              wrapperInstanceId: '513ea14b-e0b7-4bd8-b6d3-76a05c509c11',
            })
          ).resolves.toEqual({ allowed: false, reason: 'wrapper_instance_mismatch' });
          expect(await loadDeadlines(state.storage)).toEqual(before);
          expect(await state.storage.getAlarm()).toBe(idleStop);
          expect(provider.ensureLeaseAtLeast).not.toHaveBeenCalled();

          await expect(instance.recordTerminalActivity(activity)).resolves.toEqual({
            allowed: true,
          });
          expect(await loadDeadlines(state.storage)).toEqual({
            ...current,
            idleStop: now + DEADLINE_MS.idleStop,
          });
          expect(await state.storage.getAlarm()).toBe(current.heartbeatExpiry);
          expect(provider.ensureLeaseAtLeast).toHaveBeenCalledExactlyOnceWith(
            providerRef,
            DEADLINE_MS.idleStop + DEADLINE_MS.idleStopLeaseMargin
          );
        });

        clock.mockReturnValue(now + 1_001);
        await expect(runDurableObjectAlarm(control)).resolves.toBe(true);
        await expect(control.getPhysicalRecord()).resolves.toMatchObject({ state: 'running' });
        expect(provider.stop).not.toHaveBeenCalled();
        expect(provider.create).not.toHaveBeenCalled();

        await runInDurableObject(control, async (instance, state) => {
          const current = await loadDeadlines(state.storage);
          const later = now + 2 * DEADLINE_MS.idleStop;
          await saveDeadlines(state.storage, { ...current, idleStop: later });
          const alarmAt = await state.storage.getAlarm();
          await expect(instance.recordTerminalActivity(activity)).resolves.toEqual({
            allowed: true,
          });
          expect(await loadDeadlines(state.storage)).toEqual({ ...current, idleStop: later });
          expect(await state.storage.getAlarm()).toBe(alarmAt);
        });
      } finally {
        clock.mockRestore();
        socket.close();
      }
    }
  );
});

describe('SandboxControl worktree routes', () => {
  it('durably preserves concurrent sibling attaches in one directory', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__worktree_concurrent_attach');

    const routes = await runInDurableObject(stub, async instance => {
      await instance.initializeOwner('owner_1');
      await instance.claimCreate(
        'intent_routes',
        false,
        undefined,
        WORKTREE_CREDENTIAL_CONTAINMENT
      );
      await Promise.all([
        attachGrantedSession(instance, instance['ctx'], groupedRoute(GRANT_SESSION_ID, ROOT_ID)),
        attachGrantedSession(
          instance,
          instance['ctx'],
          groupedRoute(SECOND_GRANT_SESSION_ID, SECOND_ROOT_ID)
        ),
      ]);
      return instance.listRoutes();
    });

    expect(routes).toHaveLength(2);
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining(groupedRoute(GRANT_SESSION_ID, ROOT_ID)),
        expect.objectContaining(groupedRoute(SECOND_GRANT_SESSION_ID, SECOND_ROOT_ID)),
      ])
    );
  });

  it('rejects mismatched groups, duplicate roots, and worktree directory divergence', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__worktree_route_conflicts');

    await runInDurableObject(stub, async instance => {
      await instance.initializeOwner('owner_1');
      await instance.claimCreate(
        'intent_routes',
        false,
        undefined,
        WORKTREE_CREDENTIAL_CONTAINMENT
      );
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(GRANT_SESSION_ID, ROOT_ID)
      );

      await expect(
        attachGrantedSession(instance, instance['ctx'], {
          ...groupedRoute(SECOND_GRANT_SESSION_ID, SECOND_ROOT_ID),
          worktreeId: OTHER_WORKTREE_ID,
        })
      ).rejects.toThrow('Directory already attached');
      await expect(
        attachGrantedSession(instance, instance['ctx'], {
          ...groupedRoute(SECOND_GRANT_SESSION_ID, SECOND_ROOT_ID),
          directory: '/workspace/other',
        })
      ).rejects.toThrow('Worktree already attached to another directory');
      await expect(
        attachGrantedSession(
          instance,
          instance['ctx'],
          groupedRoute(SECOND_GRANT_SESSION_ID, ROOT_ID)
        )
      ).rejects.toThrow('Kilo session already attached');
      await expect(
        attachGrantedSession(instance, instance['ctx'], {
          sessionId: SECOND_GRANT_SESSION_ID,
          kiloSessionId: SECOND_ROOT_ID,
          directory: '/workspace/shared',
          ownerId: 'owner_1',
        })
      ).rejects.toThrow('Directory already attached');

      expect(await instance.listRoutes()).toHaveLength(1);
    });
  });

  it('retains ungrouped persisted routes without inventing a worktree', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__worktree_legacy_route');

    await runInDurableObject(stub, async (instance, state) => {
      await instance.initializeOwner('owner_1');
      await instance.claimCreate(
        'intent_routes',
        false,
        undefined,
        WORKTREE_CREDENTIAL_CONTAINMENT
      );
      await state.storage.put('session_routes', [
        {
          sessionId: 'workspace_legacy',
          kiloSessionId: 'kilo_legacy',
          directory: '/workspace/shared',
          ownerId: 'owner_1',
          lastState: null,
          lastStateAt: null,
          idleForMs: null,
          waitingOn: null,
          needsSync: false,
          stalled: false,
        },
      ]);

      expect(await instance.listRoutes()).toEqual([
        expect.not.objectContaining({ worktreeId: expect.anything() }),
      ]);
      await expect(
        attachGrantedSession(instance, instance['ctx'], groupedRoute(GRANT_SESSION_ID, ROOT_ID))
      ).rejects.toThrow('Directory already attached');
    });
  });
});

describe('SandboxControl targeted detach', () => {
  it('awaits live wrapper detach and preserves siblings attached during that request', async () => {
    const targetSandboxId = 'sbx__worktree_live_detach';
    const credential = generateSandboxCredential();
    const stub = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedRunningCredential(credential, targetSandboxId);
    await runInDurableObject(stub, async instance => {
      await instance.initializeOwner('owner_1');
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(GRANT_SESSION_ID, ROOT_ID)
      );
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(SECOND_GRANT_SESSION_ID, SECOND_ROOT_ID)
      );
    });

    const ws = await connect(credential, targetSandboxId);
    await completeHello(ws, 'hello-live-detach');
    const inbound = nextMessage(ws);
    const pending = runInDurableObject(stub, instance =>
      instance.detachSession(SECOND_GRANT_SESSION_ID)
    );
    const request = JSON.parse(await inbound) as WrapperRequest;
    expect(request).toMatchObject({
      operation: 'session.detach',
      session: {
        sessionId: SECOND_GRANT_SESSION_ID,
        kiloSessionId: SECOND_ROOT_ID,
        directory: '/workspace/shared',
      },
      payload: {},
    });

    await runInDurableObject(stub, async instance => {
      expect(await instance.listRoutes()).toHaveLength(2);
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute('workspace_33333333-3333-4333-8333-333333333333', THIRD_ROOT_ID)
      );
    });
    respondToWrapperRequest(ws, request, { detached: true });
    await expect(pending).resolves.toEqual({ existed: true });

    await runInDurableObject(stub, async instance => {
      expect((await instance.listRoutes()).map(route => route.sessionId).sort()).toEqual([
        GRANT_SESSION_ID,
        'workspace_33333333-3333-4333-8333-333333333333',
      ]);
    });
    ws.close();
  });

  it('retains the durable route when a connected wrapper rejects detach', async () => {
    const targetSandboxId = 'sbx__worktree_failed_detach';
    const credential = generateSandboxCredential();
    const stub = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedRunningCredential(credential, targetSandboxId);
    await runInDurableObject(stub, async instance => {
      await instance.initializeOwner('owner_1');
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(GRANT_SESSION_ID, ROOT_ID)
      );
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(SECOND_GRANT_SESSION_ID, SECOND_ROOT_ID)
      );
    });

    const ws = await connect(credential, targetSandboxId);
    await completeHello(ws, 'hello-failed-detach');
    const inbound = nextMessage(ws);
    const pending = runInDurableObject(stub, instance =>
      instance.detachSession(SECOND_GRANT_SESSION_ID)
    );
    const request = JSON.parse(await inbound) as WrapperRequest;
    ws.send(
      JSON.stringify({
        type: 'response',
        requestId: request.requestId,
        ok: false,
        error: { code: 'not_ready', message: 'detach rejected', retryable: true },
      })
    );

    await expect(pending).rejects.toThrow('detach rejected');
    await runInDurableObject(stub, async instance => {
      expect((await instance.listRoutes()).map(route => route.sessionId).sort()).toEqual([
        GRANT_SESSION_ID,
        SECOND_GRANT_SESSION_ID,
      ]);
    });
    ws.close();
  });

  it('removes a disconnected root without disturbing siblings or arming idle stop', async () => {
    const stub = env.SANDBOX_CONTROL.getByName('sbx__worktree_disconnected_detach');

    await runInDurableObject(stub, async (instance, state) => {
      await instance.initializeOwner('owner_1');
      await instance.claimCreate(
        'intent_routes',
        false,
        undefined,
        WORKTREE_CREDENTIAL_CONTAINMENT
      );
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(GRANT_SESSION_ID, ROOT_ID)
      );
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(SECOND_GRANT_SESSION_ID, SECOND_ROOT_ID)
      );

      await expect(instance.detachSession(SECOND_GRANT_SESSION_ID)).resolves.toEqual({
        existed: true,
      });
      await expect(instance.detachSession(SECOND_GRANT_SESSION_ID)).resolves.toEqual({
        existed: false,
      });
      expect(await instance.listRoutes()).toEqual([
        expect.objectContaining({ sessionId: GRANT_SESSION_ID, kiloSessionId: ROOT_ID }),
      ]);
      expect((await loadDeadlines(state.storage)).idleStop).toBeUndefined();
    });
  });
});

describe('SandboxControl worktree activity deadlines', () => {
  it('tracks both roots, retains a prompt handoff deadline until heartbeat, and re-arms after detach', async () => {
    const targetSandboxId = 'sbx__worktree_idle_deadlines';
    const credential = generateSandboxCredential();
    const stub = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedRunningCredential(credential, targetSandboxId);
    await runInDurableObject(stub, async instance => {
      await instance.initializeOwner('owner_1');
      await seedRunningCloudflare(instance);
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(GRANT_SESSION_ID, ROOT_ID)
      );
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(SECOND_GRANT_SESSION_ID, SECOND_ROOT_ID)
      );
    });

    const ws = await connect(credential, targetSandboxId);
    await completeHello(ws, 'hello-idle-deadlines');
    await deliverWrapperEvent(stub, 'sandbox.ready', {
      kiloReady: true,
      globalFeedAttached: true,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const deadlines = await state.storage.get<{ idleStop?: number }>('deadlines');
      expect(deadlines?.idleStop).toEqual(expect.any(Number));
    });

    await deliverWrapperEvent(stub, 'sandbox.heartbeat', {
      state: 'finalizing',
      kilo: { ready: true },
      sessions: [
        { kiloSessionId: ROOT_ID, state: 'idle', idleForMs: 15 },
        {
          kiloSessionId: SECOND_ROOT_ID,
          state: 'finalizing',
          idleForMs: 3,
          waitingOn: 'finalizing',
        },
      ],
    });
    await runInDurableObject(stub, async (instance, state) => {
      expect(await instance.listRoutes()).toEqual([
        expect.objectContaining({ kiloSessionId: ROOT_ID, lastState: 'idle', idleForMs: 15 }),
        expect.objectContaining({
          kiloSessionId: SECOND_ROOT_ID,
          lastState: 'finalizing',
          waitingOn: 'finalizing',
        }),
      ]);
      await expect(instance.getStatus()).resolves.toMatchObject({ work: 'finalizing' });
      expect(
        (await state.storage.get<{ idleStop?: number }>('deadlines'))?.idleStop
      ).toBeUndefined();
    });

    await deliverWrapperEvent(stub, 'sandbox.heartbeat', {
      state: 'idle',
      kilo: { ready: true },
      sessions: [
        { kiloSessionId: ROOT_ID, state: 'idle', idleForMs: 25 },
        { kiloSessionId: SECOND_ROOT_ID, state: 'idle', idleForMs: 5 },
      ],
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect((await state.storage.get<{ idleStop?: number }>('deadlines'))?.idleStop).toEqual(
        expect.any(Number)
      );
    });

    const inboundPrompt = nextMessage(ws);
    const prompt = runInDurableObject(stub, instance =>
      instance.request({
        operation: 'session.prompt',
        session: {
          sessionId: SECOND_GRANT_SESSION_ID,
          kiloSessionId: SECOND_ROOT_ID,
          directory: '/workspace/shared',
        },
        payload: {
          messageId: 'msg_idle_handoff',
          turn: { type: 'prompt', prompt: 'remain active' },
          agent: { mode: 'code', model: 'test' },
        },
      })
    );
    const promptRequest = JSON.parse(await inboundPrompt) as WrapperRequest;
    await runInDurableObject(stub, async (instance, state) => {
      const deadline = (await state.storage.get<{ idleStop?: number }>('deadlines'))?.idleStop;
      expect(deadline).toBeGreaterThan(Date.now());
      expect(deadline).toBeLessThanOrEqual(Date.now() + DEADLINE_MS.idleStop);
      expect(await instance.listRoutes()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kiloSessionId: ROOT_ID, lastState: 'idle' }),
          expect.objectContaining({ kiloSessionId: SECOND_ROOT_ID, lastState: 'active' }),
        ])
      );
    });
    respondToWrapperRequest(ws, promptRequest, {
      messageId: 'msg_idle_handoff',
      status: 'accepted',
    });
    await expect(prompt).resolves.toMatchObject({ ok: true });

    await deliverWrapperEvent(stub, 'sandbox.heartbeat', {
      state: 'active',
      kilo: { ready: true },
      sessions: [
        { kiloSessionId: ROOT_ID, state: 'active', idleForMs: 0, waitingOn: 'tool' },
        { kiloSessionId: SECOND_ROOT_ID, state: 'idle', idleForMs: 2 },
      ],
    });
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.getStatus()).resolves.toMatchObject({ work: 'active' });
      expect(
        (await state.storage.get<{ idleStop?: number }>('deadlines'))?.idleStop
      ).toBeUndefined();
    });

    const inboundDetach = nextMessage(ws);
    const detached = runInDurableObject(stub, instance => instance.detachSession(GRANT_SESSION_ID));
    const detachRequest = JSON.parse(await inboundDetach) as WrapperRequest;
    expect(detachRequest.session?.kiloSessionId).toBe(ROOT_ID);
    respondToWrapperRequest(ws, detachRequest, { detached: true });
    await expect(detached).resolves.toEqual({ existed: true });

    await runInDurableObject(stub, async (instance, state) => {
      expect(await instance.listRoutes()).toEqual([
        expect.objectContaining({ kiloSessionId: SECOND_ROOT_ID, lastState: 'idle' }),
      ]);
      expect((await state.storage.get<{ idleStop?: number }>('deadlines'))?.idleStop).toEqual(
        expect.any(Number)
      );
    });
    ws.close();
  });
});

describe('SandboxSession worktree admission', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ valid: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves repository branches and exact providers while forcing grouped auto-commit off', async () => {
    const ownerId = 'user_grouped_registration';
    const sessionId = 'workspace_grouped_registration';
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    const metadata = await runInDurableObject(stub, async instance => {
      const registered = await instance.registerSession(
        groupedRegistration({
          ownerId,
          sessionId,
          kiloSessionId: 'kilo_grouped_registration',
          sandboxId: 'ses-acde1234',
          provider: 'vercel',
        })
      );
      expect(registered.success).toBe(true);
      return instance.getMetadata();
    });

    expect(metadata).toMatchObject({
      repository: {
        type: 'github',
        repo: 'Kilo-Org/cloud',
        upstreamBranch: 'feature/shared-worktree',
      },
      workspace: {
        sandboxId: 'ses-acde1234',
        sandboxProvider: 'vercel',
        workspacePath: '/workspace/shared',
        worktreeId: WORKTREE_ID,
      },
      finalization: { autoCommit: false, condenseOnComplete: true },
    });
  });

  it('persists canonical prompt identity and attachments during registration-only creation', async () => {
    const ownerId = 'user_grouped_registered_prompt';
    const sessionId = 'workspace_grouped_registered_prompt';
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
    };
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        ...groupedRegistration({
          ownerId,
          sessionId,
          kiloSessionId: 'kilo_grouped_registered_prompt',
          sandboxId: 'usr-abcdef123410',
        }),
        message: {
          initialMessageId: INITIAL_MESSAGE_ID,
          turn: {
            type: 'prompt',
            id: INITIAL_MESSAGE_ID,
            prompt: 'inspect the document',
            attachments,
          },
        },
      });

      expect((await instance.getMetadata())?.initialMessage).toEqual({
        id: INITIAL_MESSAGE_ID,
        prompt: 'inspect the document',
        attachments,
        turn: { type: 'prompt', prompt: 'inspect the document', attachments },
      });
    });
  });

  it('preserves auto-commit for ungrouped sessions', async () => {
    const ownerId = 'user_ungrouped_registration';
    const sessionId = 'workspace_ungrouped_registration';
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    const metadata = await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        identity: { sessionId, userId: ownerId },
        auth: { kiloSessionId: 'kilo_ungrouped_registration' },
        agent: { mode: 'code', model: 'test-model' },
        workspace: { sandboxId: 'usr-abcdef12', workspacePath: '/workspace/legacy' },
        finalization: { autoCommit: true },
      });
      return instance.getMetadata();
    });

    expect(metadata?.workspace?.worktreeId).toBeUndefined();
    expect(metadata?.finalization?.autoCommit).toBe(true);
  });

  it('forces grouped auto-commit off before first attach and prompt delivery', async () => {
    const ownerId = 'user_grouped_initial';
    const sessionId = GRANT_SESSION_ID;
    const targetSandboxId = 'usr-abcdef123401';
    const kiloSessionId = ROOT_ID;
    const credential = generateSandboxCredential();
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedCredential(credential, targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await seedRunningCloudflare(instance);
    });
    await installProvider(control, cloudflareRef(targetSandboxId));

    const ws = await connect(credential, targetSandboxId);
    await completeHello(ws, 'hello-grouped-initial', { wrapperInstanceId: crypto.randomUUID() });
    await deliverWrapperEvent(control, 'sandbox.ready', {
      kiloReady: true,
      globalFeedAttached: true,
    });

    const session = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    const incomingAttach = nextMessage(ws);
    const initialTurn = {
      type: 'prompt',
      messageId: INITIAL_MESSAGE_ID,
      prompt: 'first grouped turn',
    } as const;
    const admitted = await runInDurableObject(session, instance =>
      instance.createSessionWithInitialAdmission({
        ...groupedRegistration({ ownerId, sessionId, kiloSessionId, sandboxId: targetSandboxId }),
        message: { initialTurn },
      })
    );
    expect(admitted).toMatchObject({ success: true, messageId: INITIAL_MESSAGE_ID });

    const attach = JSON.parse(await incomingAttach) as WrapperRequest;
    expect(attach).toMatchObject({
      operation: 'session.attach',
      session: { sessionId, kiloSessionId, directory: '/workspace/shared' },
      payload: { branch: 'feature/shared-worktree' },
    });
    await runInDurableObject(session, async (instance, state) => {
      const metadata = await instance.getMetadata();
      expect(metadata?.finalization?.autoCommit).toBe(false);
      expect(metadata?.initialMessage).toEqual({
        id: INITIAL_MESSAGE_ID,
        prompt: 'first grouped turn',
        turn: { type: 'prompt', prompt: 'first grouped turn' },
      });
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({
          messageId: INITIAL_MESSAGE_ID,
          intent: expect.objectContaining({
            turn: {
              type: 'prompt',
              messageId: INITIAL_MESSAGE_ID,
              prompt: 'first grouped turn',
            },
            agent: { mode: 'code', model: 'test-model' },
            finalization: { autoCommit: false, condenseOnComplete: true },
          }),
        }),
      ]);
    });
    await runInDurableObject(control, async instance => {
      expect(await instance.listRoutes()).toEqual([
        expect.objectContaining({ sessionId, kiloSessionId, worktreeId: WORKTREE_ID }),
      ]);
    });

    const incomingPrompt = nextMessage(ws);
    respondToWrapperRequest(ws, attach, { attached: true });
    const prompt = JSON.parse(await incomingPrompt) as WrapperRequest;
    expect(prompt).toMatchObject({
      operation: 'session.prompt',
      session: { sessionId, kiloSessionId },
      payload: {
        messageId: INITIAL_MESSAGE_ID,
        finalization: { autoCommit: false, condenseOnComplete: true },
      },
    });
    respondToWrapperRequest(ws, prompt, {
      messageId: INITIAL_MESSAGE_ID,
      status: 'accepted',
    });
    ws.close();
  });

  it('persists and dispatches initial command turns with their agent and arguments', async () => {
    const ownerId = 'user_grouped_initial_command';
    const sessionId = GRANT_SESSION_ID;
    const targetSandboxId = 'usr-abcdef123411';
    const kiloSessionId = ROOT_ID;
    const credential = generateSandboxCredential();
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedCredential(credential, targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await seedRunningCloudflare(instance);
    });
    await installProvider(control, cloudflareRef(targetSandboxId));

    const wrapper = await connect(credential, targetSandboxId);
    await completeHello(wrapper, 'hello-grouped-command', {
      wrapperInstanceId: crypto.randomUUID(),
    });
    await deliverWrapperEvent(control, 'sandbox.ready', {
      kiloReady: true,
      globalFeedAttached: true,
    });

    const session = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    const incomingAttach = nextMessage(wrapper);
    const initialTurn = {
      type: 'command' as const,
      messageId: INITIAL_MESSAGE_ID,
      command: 'compact',
      arguments: '--aggressive',
    };
    const registration = {
      ...groupedRegistration({ ownerId, sessionId, kiloSessionId, sandboxId: targetSandboxId }),
      agent: { mode: 'architect', model: 'kilo/command-model', variant: 'thinking' },
      message: { initialTurn },
    };
    const admitted = await runInDurableObject(session, instance =>
      instance.createSessionWithInitialAdmission(registration)
    );
    expect(admitted).toMatchObject({ success: true, messageId: INITIAL_MESSAGE_ID });

    const attach = JSON.parse(await incomingAttach) as WrapperRequest;
    await runInDurableObject(session, async (instance, state) => {
      expect((await instance.getMetadata())?.initialMessage).toEqual({
        id: INITIAL_MESSAGE_ID,
        prompt: '/compact --aggressive',
        turn: { type: 'command', command: 'compact', arguments: '--aggressive' },
      });
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({
          version: 2,
          intent: {
            turn: initialTurn,
            agent: { mode: 'architect', model: 'kilo/command-model', variant: 'thinking' },
            finalization: { autoCommit: false, condenseOnComplete: true },
          },
        }),
      ]);
      await expect(instance.createSessionWithInitialAdmission(registration)).resolves.toMatchObject(
        {
          success: true,
          messageId: INITIAL_MESSAGE_ID,
        }
      );
      await expect(
        instance.createSessionWithInitialAdmission({
          ...registration,
          message: {
            initialTurn: { ...initialTurn, arguments: '--different' },
          },
        })
      ).resolves.toMatchObject({
        success: false,
        code: 'BAD_REQUEST',
      });
    });

    const incomingCommand = nextMessage(wrapper);
    respondToWrapperRequest(wrapper, attach, { attached: true });
    const command = JSON.parse(await incomingCommand) as WrapperRequest;
    expect(command).toMatchObject({
      operation: 'session.prompt',
      session: { sessionId, kiloSessionId },
      payload: {
        messageId: INITIAL_MESSAGE_ID,
        turn: { type: 'command', command: 'compact', arguments: '--aggressive' },
        agent: { mode: 'architect', model: 'command-model', variant: 'thinking' },
        finalization: { autoCommit: false, condenseOnComplete: true },
      },
    });
    respondToWrapperRequest(wrapper, command, {
      messageId: INITIAL_MESSAGE_ID,
      status: 'accepted',
    });
    wrapper.close();
  });

  it('dispatches signed prompt attachments and preserves follow-up agent overrides', async () => {
    const ownerId = 'user_grouped_attachment';
    const sessionId = GRANT_SESSION_ID;
    const targetSandboxId = 'usr-abcdef123412';
    const kiloSessionId = ROOT_ID;
    const attachments = {
      path: '123e4567-e89b-12d3-a456-426614174000',
      files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
    };
    const credential = generateSandboxCredential();
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedCredential(credential, targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await seedRunningCloudflare(instance);
    });
    await installProvider(control, cloudflareRef(targetSandboxId));

    const wrapper = await connect(credential, targetSandboxId);
    await completeHello(wrapper, 'hello-grouped-attachment', {
      wrapperInstanceId: crypto.randomUUID(),
    });
    await deliverWrapperEvent(control, 'sandbox.ready', {
      kiloReady: true,
      globalFeedAttached: true,
    });

    const session = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    const incomingAttach = nextMessage(wrapper);
    await runInDurableObject(session, async instance => {
      Object.assign(instance['env'], {
        R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID: 'test-access-key',
        R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: 'test-secret-key',
        R2_ENDPOINT: 'https://attachments.example.test',
        R2_ATTACHMENTS_BUCKET: 'test-attachments',
      });
      await instance.registerSession(
        groupedRegistration({ ownerId, sessionId, kiloSessionId, sandboxId: targetSandboxId })
      );
      await expect(
        instance.admitSubmittedMessage({
          userId: ownerId,
          turn: {
            type: 'prompt',
            id: INITIAL_MESSAGE_ID,
            prompt: 'review the document',
            attachments,
          },
          agent: { mode: 'debug', model: 'kilo/override-model', variant: 'focused' },
          finalization: { autoCommit: true, condenseOnComplete: false },
        })
      ).resolves.toMatchObject({ success: true, messageId: INITIAL_MESSAGE_ID });
    });

    const attach = JSON.parse(await incomingAttach) as WrapperRequest;
    await runInDurableObject(session, async (_instance, state) => {
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({
          intent: {
            turn: {
              type: 'prompt',
              messageId: INITIAL_MESSAGE_ID,
              prompt: 'review the document',
              attachments,
            },
            agent: { mode: 'debug', model: 'kilo/override-model', variant: 'focused' },
            finalization: { autoCommit: false, condenseOnComplete: false },
          },
        }),
      ]);
    });
    const incomingPrompt = nextMessage(wrapper);
    respondToWrapperRequest(wrapper, attach, { attached: true });
    const prompt = JSON.parse(await incomingPrompt) as WrapperRequest & {
      payload: {
        attachments: Array<{
          mime: string;
          signedUrl: string;
          filename: string;
          localPath: string;
        }>;
      };
    };
    expect(prompt).toMatchObject({
      operation: 'session.prompt',
      payload: {
        messageId: INITIAL_MESSAGE_ID,
        turn: { type: 'prompt', prompt: 'review the document' },
        agent: { mode: 'debug', model: 'override-model', variant: 'focused' },
        finalization: { autoCommit: false, condenseOnComplete: false },
      },
    });
    expect(prompt.payload.attachments).toHaveLength(1);
    expect(prompt.payload.attachments[0]).toMatchObject({
      mime: 'application/pdf',
      filename: attachments.files[0],
    });
    const signedUrl = prompt.payload.attachments[0]?.signedUrl;
    if (!signedUrl) throw new Error('Expected a signed attachment URL');
    const parsed = new URL(signedUrl);
    expect(parsed.origin).toBe('https://attachments.example.test');
    expect(parsed.pathname).toBe(
      `/test-attachments/${ownerId}/cloud-agent/${attachments.path}/${attachments.files[0]}`
    );
    expect(parsed.searchParams.has('X-Amz-Signature')).toBe(true);

    respondToWrapperRequest(wrapper, prompt, {
      messageId: INITIAL_MESSAGE_ID,
      status: 'accepted',
    });
    wrapper.close();
  });

  it('dispatches follow-up commands and preserves ungrouped per-turn finalization', async () => {
    const ownerId = 'user_ungrouped_followup_command';
    const sessionId = GRANT_SESSION_ID;
    const targetSandboxId = 'usr-abcdef123416';
    const kiloSessionId = ROOT_ID;
    const credential = generateSandboxCredential();
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedCredential(credential, targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await seedRunningCloudflare(instance);
    });
    await installProvider(control, cloudflareRef(targetSandboxId));

    const wrapper = await connect(credential, targetSandboxId);
    await completeHello(wrapper, 'hello-ungrouped-followup-command', {
      wrapperInstanceId: crypto.randomUUID(),
    });
    await deliverWrapperEvent(control, 'sandbox.ready', {
      kiloReady: true,
      globalFeedAttached: true,
    });
    const session = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    const incomingAttach = nextMessage(wrapper);
    await runInDurableObject(session, async instance => {
      await instance.registerSession({
        identity: { sessionId, userId: ownerId },
        auth: { kiloSessionId, kilocodeToken: KILO_TOKEN },
        agent: { mode: 'code', model: 'default-model' },
        workspace: { sandboxId: targetSandboxId, workspacePath: '/workspace/shared' },
        finalization: { autoCommit: false, condenseOnComplete: true },
      });
      await expect(
        instance.admitSubmittedMessage({
          userId: ownerId,
          turn: {
            type: 'command',
            id: INITIAL_MESSAGE_ID,
            command: 'review',
            arguments: '--base main',
          },
          agent: { mode: 'architect', model: 'kilo/followup-model', variant: 'deep' },
          finalization: { autoCommit: true, condenseOnComplete: false },
        })
      ).resolves.toMatchObject({ success: true, messageId: INITIAL_MESSAGE_ID });
    });

    const attach = JSON.parse(await incomingAttach) as WrapperRequest;
    const incomingCommand = nextMessage(wrapper);
    respondToWrapperRequest(wrapper, attach, { attached: true });
    const command = JSON.parse(await incomingCommand) as WrapperRequest;
    expect(command).toMatchObject({
      operation: 'session.prompt',
      payload: {
        messageId: INITIAL_MESSAGE_ID,
        turn: { type: 'command', command: 'review', arguments: '--base main' },
        agent: { mode: 'architect', model: 'followup-model', variant: 'deep' },
        finalization: { autoCommit: true, condenseOnComplete: false },
      },
    });
    respondToWrapperRequest(wrapper, command, {
      messageId: INITIAL_MESSAGE_ID,
      status: 'accepted',
    });
    wrapper.close();
  });

  it('rejects attachments on command submissions without admitting a message', async () => {
    const ownerId = 'user_grouped_command_attachments';
    const sessionId = 'workspace_grouped_command_attachments';
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      await instance.registerSession(
        groupedRegistration({
          ownerId,
          sessionId,
          kiloSessionId: 'kilo_grouped_command_attachments',
          sandboxId: 'usr-abcdef123413',
        })
      );
      await expect(
        instance.admitSubmittedMessage({
          userId: ownerId,
          turn: {
            type: 'command',
            id: INITIAL_MESSAGE_ID,
            command: 'compact',
            arguments: '',
            attachments: {
              path: '123e4567-e89b-12d3-a456-426614174000',
              files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
            },
          },
        })
      ).resolves.toEqual({
        success: false,
        code: 'BAD_REQUEST',
        error: 'Attachments cannot be attached to slash commands',
      });
      expect(await state.storage.get('session_messages')).toBeUndefined();
    });
  });

  it('overrides a submitted grouped turn that requests auto-commit', async () => {
    const ownerId = 'user_grouped_followup';
    const sessionId = 'workspace_grouped_followup';
    const targetSandboxId = 'usr-abcdef123402';
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await instance.claimCreate('grouped-followup-intent');
    });
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      await instance.registerSession(
        groupedRegistration({
          ownerId,
          sessionId,
          kiloSessionId: 'kilo_grouped_followup',
          sandboxId: targetSandboxId,
        })
      );
      const staleMetadata = await instance.getMetadata();
      if (!staleMetadata) throw new Error('Expected grouped session metadata');
      await state.storage.put('session_metadata', {
        ...staleMetadata,
        finalization: { ...staleMetadata.finalization, autoCommit: true },
      });
      const admitted = await instance.admitSubmittedMessage({
        userId: ownerId,
        turn: { type: 'prompt', id: 'msg_grouped_followup', prompt: 'follow-up' },
        finalization: { autoCommit: true, condenseOnComplete: false },
      });
      expect(admitted).toMatchObject({ success: true, messageId: 'msg_grouped_followup' });
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({
          messageId: 'msg_grouped_followup',
          intent: expect.objectContaining({
            finalization: { autoCommit: false, condenseOnComplete: false },
          }),
        }),
      ]);
      expect((await instance.getMetadata())?.finalization?.autoCommit).toBe(false);
    });
  });

  it('dispatches older prompt-only queue records with their stored finalization fallback', async () => {
    const ownerId = 'user_grouped_legacy_record';
    const sessionId = GRANT_SESSION_ID;
    const targetSandboxId = 'usr-abcdef123414';
    const kiloSessionId = ROOT_ID;
    const credential = generateSandboxCredential();
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedCredential(credential, targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await seedRunningCloudflare(instance);
    });
    await installProvider(control, cloudflareRef(targetSandboxId));

    const wrapper = await connect(credential, targetSandboxId);
    await completeHello(wrapper, 'hello-grouped-legacy-record', {
      wrapperInstanceId: crypto.randomUUID(),
    });
    await deliverWrapperEvent(control, 'sandbox.ready', {
      kiloReady: true,
      globalFeedAttached: true,
    });

    const session = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    await runInDurableObject(session, async (instance, state) => {
      await instance.registerSession(
        groupedRegistration({ ownerId, sessionId, kiloSessionId, sandboxId: targetSandboxId })
      );
      await state.storage.put('session_messages', [
        {
          messageId: 'msg_legacy_record',
          state: 'queued',
          prompt: 'recover an older prompt',
          finalization: { autoCommit: true, condenseOnComplete: false },
        },
      ]);
    });

    const incomingAttach = nextMessage(wrapper);
    const dispatched = runInDurableObject(session, instance => instance.alarm());
    const attach = JSON.parse(await incomingAttach) as WrapperRequest;
    const incomingPrompt = nextMessage(wrapper);
    respondToWrapperRequest(wrapper, attach, { attached: true });
    const prompt = JSON.parse(await incomingPrompt) as WrapperRequest;
    expect(prompt).toMatchObject({
      operation: 'session.prompt',
      payload: {
        messageId: 'msg_legacy_record',
        turn: { type: 'prompt', prompt: 'recover an older prompt' },
        agent: { mode: 'code', model: 'test-model' },
        finalization: { autoCommit: false, condenseOnComplete: false },
      },
    });
    respondToWrapperRequest(wrapper, prompt, {
      messageId: 'msg_legacy_record',
      status: 'accepted',
    });
    await expect(dispatched).resolves.toBeUndefined();
    wrapper.close();
  });
});

describe('SandboxSession durable message lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ valid: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists and streams exactly one sent event per accepted sibling prompt', async () => {
    const ownerId = 'user_grouped_sent';
    const targetSandboxId = 'usr-abcdef123417';
    const roots = [
      {
        sessionId: GRANT_SESSION_ID,
        kiloSessionId: ROOT_ID,
        messageId: INITIAL_MESSAGE_ID,
        prompt: 'first root turn',
      },
      {
        sessionId: SECOND_GRANT_SESSION_ID,
        kiloSessionId: SECOND_ROOT_ID,
        messageId: 'msg_018f1e2d3c4bNoPmLkJiHgFeDc',
        prompt: 'second root turn',
      },
    ] as const;
    const credential = generateSandboxCredential();
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedCredential(credential, targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await seedRunningCloudflare(instance);
    });
    await installProvider(control, cloudflareRef(targetSandboxId));

    const wrapper = await connect(credential, targetSandboxId);
    await completeHello(wrapper, 'hello-grouped-sent', { wrapperInstanceId: crypto.randomUUID() });
    await deliverWrapperEvent(control, 'sandbox.ready', {
      kiloReady: true,
      globalFeedAttached: true,
    });

    const sessions = await Promise.all(
      roots.map(async root => {
        const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${root.sessionId}`);
        await runInDurableObject(stub, instance =>
          instance.registerSession(
            groupedRegistration({
              ownerId,
              sessionId: root.sessionId,
              kiloSessionId: root.kiloSessionId,
              sandboxId: targetSandboxId,
            })
          )
        );
        const stream = await connectSessionStream(root.sessionId, ownerId, ['cloud.message.sent']);
        const observed: SessionStreamEvent[] = [];
        stream.addEventListener('message', event => {
          observed.push(JSON.parse(String(event.data)) as SessionStreamEvent);
        });
        return { ...root, stub, stream, observed };
      })
    );

    for (const session of sessions) {
      const incomingAttach = nextMessage(wrapper);
      const admission = await runInDurableObject(session.stub, instance =>
        instance.admitSubmittedMessage({
          userId: ownerId,
          turn: { type: 'prompt', id: session.messageId, prompt: session.prompt },
        })
      );
      expect(admission).toMatchObject({
        success: true,
        messageId: session.messageId,
        compatibilityDelivery: 'queued',
      });

      const attach = JSON.parse(await incomingAttach) as WrapperRequest;
      expect(attach).toMatchObject({
        operation: 'session.attach',
        session: {
          sessionId: session.sessionId,
          kiloSessionId: session.kiloSessionId,
          directory: '/workspace/shared',
        },
      });
      const incomingPrompt = nextMessage(wrapper);
      respondToWrapperRequest(wrapper, attach, { attached: true });
      const prompt = JSON.parse(await incomingPrompt) as WrapperRequest;
      expect(prompt).toMatchObject({
        operation: 'session.prompt',
        session: { sessionId: session.sessionId, kiloSessionId: session.kiloSessionId },
        payload: { messageId: session.messageId },
      });

      const incomingSent = nextMessage(session.stream);
      respondToWrapperRequest(wrapper, prompt, {
        messageId: session.messageId,
        status: 'accepted',
      });
      const sent = JSON.parse(await incomingSent) as SessionStreamEvent;
      expect(sent).toMatchObject({
        sessionId: session.sessionId,
        streamEventType: 'cloud.message.sent',
        data: { messageId: session.messageId, delivery: 'sent' },
      });
      expect(sent.eventId).toBeGreaterThan(0);

      await runInDurableObject(session.stub, async (instance, state) => {
        const events = persistedSessionEvents(state, ['cloud.message.sent']);
        expect(events).toHaveLength(1);
        expect(events[0]?.session_id).toBe(session.sessionId);
        expect(JSON.parse(events[0]?.payload ?? '')).toEqual({
          messageId: session.messageId,
          delivery: 'sent',
        });
        await expect(
          instance.admitSubmittedMessage({
            userId: ownerId,
            turn: { type: 'prompt', id: session.messageId, prompt: session.prompt },
          })
        ).resolves.toEqual({
          success: true,
          outcome: 'queued',
          messageId: session.messageId,
          compatibilityDelivery: 'sent',
        });
        expect(persistedSessionEvents(state, ['cloud.message.sent'])).toHaveLength(1);
      });
    }

    for (const session of sessions) {
      expect(
        session.observed.map(event => ({ sessionId: event.sessionId, data: event.data }))
      ).toEqual([
        { sessionId: session.sessionId, data: { messageId: session.messageId, delivery: 'sent' } },
      ]);
      session.stream.close();
    }
    wrapper.close();
  });
});

describe('SandboxSession root-owned terminal events', () => {
  it('settles only the matching root once from a fenced outcome without generic terminals', async () => {
    const wrapperInstanceId = crypto.randomUUID();
    const ownerId = 'user_grouped_terminal';
    const sessionId = GRANT_SESSION_ID;
    const siblingSessionId = SECOND_GRANT_SESSION_ID;
    const targetSandboxId = 'usr-abcdef123403';
    const root = ROOT_ID;
    const siblingRoot = SECOND_ROOT_ID;
    const lifecycleTypes = ['cloud.message.completed', 'cloud.message.failed', 'complete', 'error'];
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await instance.claimCreate(
        'grouped-terminal-intent',
        false,
        undefined,
        WORKTREE_CREDENTIAL_CONTAINMENT
      );
      await attachGrantedSession(instance, instance['ctx'], groupedRoute(sessionId, root, ownerId));
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(siblingSessionId, siblingRoot, ownerId)
      );
    });

    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.registerSession(
        groupedRegistration({ ownerId, sessionId, kiloSessionId: root, sandboxId: targetSandboxId })
      );
      await state.storage.put('session_messages', [
        { messageId: 'msg_active', state: 'accepted', acceptedAt: Date.now(), wrapperInstanceId },
        { messageId: 'msg_next', state: 'queued', prompt: 'next turn' },
      ]);
    });

    const sibling = env.SANDBOX_SESSION.getByName(`${ownerId}:${siblingSessionId}`);
    await runInDurableObject(sibling, async (instance, state) => {
      await instance.registerSession(
        groupedRegistration({
          ownerId,
          sessionId: siblingSessionId,
          kiloSessionId: siblingRoot,
          sandboxId: targetSandboxId,
        })
      );
      await state.storage.put('session_messages', [
        {
          messageId: 'msg_sibling_active',
          state: 'accepted',
          acceptedAt: Date.now(),
          wrapperInstanceId,
        },
      ]);
    });

    const stream = await connectSessionStream(sessionId, ownerId, lifecycleTypes);
    const siblingStream = await connectSessionStream(siblingSessionId, ownerId, lifecycleTypes);
    const siblingEvents: SessionStreamEvent[] = [];
    siblingStream.addEventListener('message', event => {
      siblingEvents.push(JSON.parse(String(event.data)) as SessionStreamEvent);
    });

    await runInDurableObject(stub, async (instance, state) => {
      for (const type of ['session.turn.close', 'session.error']) {
        await expect(
          instance.receiveSandboxControlEvent({
            identity: {
              directory: '/workspace/shared',
              kiloSessionId: THIRD_ROOT_ID,
              rootKiloSessionId: root,
            },
            payload: { type, properties: { sessionID: THIRD_ROOT_ID } },
          })
        ).resolves.toEqual({ applied: true });
      }
      await expect(
        instance.receiveSandboxControlEvent({
          identity: {
            directory: '/workspace/shared',
            kiloSessionId: root,
            rootKiloSessionId: siblingRoot,
          },
          payload: { type: 'session.turn.close', properties: { sessionID: root } },
        })
      ).resolves.toEqual({ applied: false });
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({ messageId: 'msg_active', state: 'accepted' }),
        expect.objectContaining({ messageId: 'msg_next', state: 'queued' }),
      ]);
      expect(persistedSessionEvents(state, lifecycleTypes)).toEqual([]);
    });

    await runInDurableObject(sibling, async (instance, state) => {
      await expect(
        instance.receiveSandboxControlEvent({
          identity: {
            directory: '/workspace/shared',
            kiloSessionId: root,
            rootKiloSessionId: root,
          },
          payload: { type: 'session.turn.close', properties: { sessionID: root } },
        })
      ).resolves.toEqual({ applied: false });
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({ messageId: 'msg_sibling_active', state: 'accepted' }),
      ]);
      expect(persistedSessionEvents(state, lifecycleTypes)).toEqual([]);
    });

    const completedPayload = {
      messageId: 'msg_active',
      status: 'completed',
      delivery: 'sent',
      accepted: true,
    };
    const terminalInput = {
      identity: {
        directory: '/workspace/shared',
        kiloSessionId: root,
        rootKiloSessionId: root,
      },
      wrapperInstanceId,
      payload: {
        type: 'session.message.outcome',
        properties: { messageId: 'msg_active', status: 'completed' },
      },
    };
    await runInDurableObject(stub, async (instance, state) => {
      for (const type of ['session.idle', 'session.turn.close', 'session.error']) {
        await instance.receiveSandboxControlEvent({
          identity: terminalInput.identity,
          wrapperInstanceId,
          payload: { type, properties: { sessionID: root } },
        });
      }
      await expect(
        instance.receiveSandboxControlEvent({
          ...terminalInput,
          wrapperInstanceId: crypto.randomUUID(),
        })
      ).resolves.toEqual({ applied: false });
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({ messageId: 'msg_active', state: 'accepted' }),
        expect.objectContaining({ messageId: 'msg_next', state: 'queued' }),
      ]);
      expect(persistedSessionEvents(state, lifecycleTypes)).toEqual([]);
    });
    const incomingTerminalEvents = nextMessages(stream, 1);
    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.receiveSandboxControlEvent(terminalInput)).resolves.toEqual({
        applied: true,
      });
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({ messageId: 'msg_active', state: 'completed' }),
        expect.objectContaining({ messageId: 'msg_next', state: 'queued' }),
      ]);
      await expect(instance.receiveSandboxControlEvent(terminalInput)).resolves.toEqual({
        applied: true,
      });
      expect(
        persistedSessionEvents(state, lifecycleTypes).map(event => ({
          type: event.stream_event_type,
          data: JSON.parse(event.payload),
        }))
      ).toEqual([{ type: 'cloud.message.completed', data: completedPayload }]);
    });

    const terminalEvents = (await incomingTerminalEvents).map(
      message => JSON.parse(message) as SessionStreamEvent
    );
    expect(
      terminalEvents.map(event => ({
        sessionId: event.sessionId,
        type: event.streamEventType,
        data: event.data,
      }))
    ).toEqual([{ sessionId, type: 'cloud.message.completed', data: completedPayload }]);
    expect(terminalEvents.every(event => event.eventId > 0)).toBe(true);

    await runInDurableObject(sibling, async (_instance, state) => {
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({ messageId: 'msg_sibling_active', state: 'accepted' }),
      ]);
      expect(persistedSessionEvents(state, lifecycleTypes)).toEqual([]);
    });
    expect(siblingEvents).toEqual([]);
    await runInDurableObject(stub, async instance => {
      await instance.interruptExecution();
      await Promise.all(instance['dispatches'].values());
    });
    siblingStream.close();
    stream.close();
  });

  it('persists and streams one canonical failure only for a fenced root outcome', async () => {
    const wrapperInstanceId = crypto.randomUUID();
    const acceptedAt = Date.now();
    const ownerId = 'user_grouped_terminal_error';
    const sessionId = GRANT_SESSION_ID;
    const root = ROOT_ID;
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.registerSession(
        groupedRegistration({
          ownerId,
          sessionId,
          kiloSessionId: root,
          sandboxId: 'usr-abcdef123418',
        })
      );
      await state.storage.put('session_messages', [
        { messageId: 'msg_grouped_failed', state: 'accepted', acceptedAt, wrapperInstanceId },
      ]);
    });

    const lifecycleTypes = ['cloud.message.failed', 'error'];
    const stream = await connectSessionStream(sessionId, ownerId, lifecycleTypes);
    const incomingTerminalEvents = nextMessages(stream, 1);
    const terminalInput = {
      identity: {
        directory: '/workspace/shared',
        kiloSessionId: root,
        rootKiloSessionId: root,
      },
      wrapperInstanceId,
      payload: {
        type: 'session.message.outcome',
        properties: { messageId: 'msg_grouped_failed', status: 'failed' },
      },
    };
    const failedPayload = {
      messageId: 'msg_grouped_failed',
      status: 'failed',
      delivery: 'sent',
      accepted: true,
      timestamp: acceptedAt,
    };

    await runInDurableObject(stub, async (instance, state) => {
      await instance.receiveSandboxControlEvent({
        identity: terminalInput.identity,
        wrapperInstanceId,
        payload: { type: 'session.error', properties: { sessionID: root } },
      });
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({ messageId: 'msg_grouped_failed', state: 'accepted' }),
      ]);
      expect(persistedSessionEvents(state, lifecycleTypes)).toEqual([]);
      await expect(instance.receiveSandboxControlEvent(terminalInput)).resolves.toEqual({
        applied: true,
      });
      await expect(instance.receiveSandboxControlEvent(terminalInput)).resolves.toEqual({
        applied: true,
      });
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({ messageId: 'msg_grouped_failed', state: 'failed' }),
      ]);
      expect(
        persistedSessionEvents(state, lifecycleTypes).map(event => ({
          type: event.stream_event_type,
          data: JSON.parse(event.payload),
        }))
      ).toEqual([{ type: 'cloud.message.failed', data: failedPayload }]);
    });

    const streamed = (await incomingTerminalEvents).map(
      message => JSON.parse(message) as SessionStreamEvent
    );
    expect(
      streamed.map(event => ({
        sessionId: event.sessionId,
        type: event.streamEventType,
        data: event.data,
      }))
    ).toEqual([{ sessionId, type: 'cloud.message.failed', data: failedPayload }]);
    expect(streamed.every(event => event.eventId > 0)).toBe(true);
    stream.close();
  });
});

describe('SandboxSession running stream state', () => {
  it('reconnects an accepted root as ready while preserving queued sibling turns', async () => {
    const ownerId = 'user_grouped_running_stream';
    const sessionId = GRANT_SESSION_ID;
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.registerSession(
        groupedRegistration({
          ownerId,
          sessionId,
          kiloSessionId: ROOT_ID,
          sandboxId: 'usr-abcdef123415',
        })
      );
      await state.storage.put('session_messages', [
        {
          messageId: 'msg_running',
          state: 'accepted',
          acceptedAt: Date.now(),
          intent: {
            turn: { type: 'prompt', messageId: 'msg_running', prompt: 'currently running' },
            agent: { mode: 'code', model: 'test-model' },
          },
        },
        {
          messageId: 'msg_waiting',
          state: 'queued',
          intent: {
            turn: {
              type: 'command',
              messageId: 'msg_waiting',
              command: 'compact',
              arguments: '--next',
            },
            agent: { mode: 'code', model: 'test-model' },
          },
        },
      ]);
    });

    const response = await SELF.fetch(
      `http://worker.test/stream?sessionId=${sessionId}&userId=${ownerId}`,
      { headers: { Upgrade: 'websocket' } }
    );
    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`Unexpected running-session stream status: ${response.status}`);
    }
    response.webSocket.accept();
    const events = (await nextMessages(response.webSocket, 4)).map(
      message => JSON.parse(message) as SessionStreamEvent
    );

    expect(events[0]).toMatchObject({
      eventId: 0,
      sessionId,
      streamEventType: 'connected',
      data: { cloudStatus: { type: 'ready' } },
    });
    expect(events.slice(1)).toEqual([
      expect.objectContaining({
        eventId: 0,
        sessionId,
        streamEventType: 'cloud.message.queued',
        data: { messageId: 'msg_running', content: 'currently running', delivery: 'queued' },
      }),
      expect.objectContaining({
        eventId: 0,
        sessionId,
        streamEventType: 'cloud.message.sent',
        data: { messageId: 'msg_running', delivery: 'sent' },
      }),
      expect.objectContaining({
        eventId: 0,
        sessionId,
        streamEventType: 'cloud.message.queued',
        data: { messageId: 'msg_waiting', content: '/compact --next', delivery: 'queued' },
      }),
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({ messageId: 'msg_running', state: 'accepted' }),
        expect.objectContaining({ messageId: 'msg_waiting', state: 'queued' }),
      ]);
    });
    response.webSocket.close();
  });
});

describe('SandboxSession root-scoped reconnect sync', () => {
  it('reconciles an accepted root before connected and replays only its questions and permissions afterward', async () => {
    const wrapperInstanceId = crypto.randomUUID();
    const ownerId = 'user_grouped_sync';
    const activeSessionId = GRANT_SESSION_ID;
    const emptySessionId = SECOND_GRANT_SESSION_ID;
    const targetSandboxId = 'usr-abcdef123404';
    const credential = generateSandboxCredential();
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedCredential(credential, targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await seedRunningCloudflare(instance);
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(activeSessionId, ROOT_ID, ownerId)
      );
    });

    const active = env.SANDBOX_SESSION.getByName(`${ownerId}:${activeSessionId}`);
    await runInDurableObject(active, async (instance, state) => {
      await instance.registerSession(
        groupedRegistration({
          ownerId,
          sessionId: activeSessionId,
          kiloSessionId: ROOT_ID,
          sandboxId: targetSandboxId,
        })
      );
      await state.storage.put('session_messages', [
        {
          messageId: INITIAL_MESSAGE_ID,
          state: 'accepted',
          acceptedAt: Date.now(),
          wrapperInstanceId,
        },
      ]);
    });
    const empty = env.SANDBOX_SESSION.getByName(`${ownerId}:${emptySessionId}`);
    await runInDurableObject(empty, async instance => {
      await instance.registerSession(
        groupedRegistration({
          ownerId,
          sessionId: emptySessionId,
          kiloSessionId: SECOND_ROOT_ID,
          sandboxId: targetSandboxId,
        })
      );
    });

    const wrapper = await connect(credential, targetSandboxId);
    await completeHello(wrapper, 'hello-grouped-sync', { wrapperInstanceId });
    await deliverWrapperEvent(control, 'sandbox.ready', {
      kiloReady: true,
      globalFeedAttached: true,
    });
    const incomingSync = nextMessage(wrapper);

    const emptyResponse = await SELF.fetch(
      `http://worker.test/stream?sessionId=${emptySessionId}&userId=${ownerId}`,
      { headers: { Upgrade: 'websocket' } }
    );
    if (emptyResponse.status !== 101 || !emptyResponse.webSocket) {
      throw new Error(`Unexpected empty-session stream status: ${emptyResponse.status}`);
    }
    emptyResponse.webSocket.accept();
    const emptyConnected = JSON.parse(await nextMessage(emptyResponse.webSocket)) as {
      streamEventType: string;
    };
    expect(emptyConnected.streamEventType).toBe('connected');

    const pendingActiveResponse = SELF.fetch(
      `http://worker.test/stream?sessionId=${activeSessionId}&userId=${ownerId}`,
      { headers: { Upgrade: 'websocket' } }
    );
    const sync = JSON.parse(await incomingSync) as WrapperRequest;
    expect(sync).toMatchObject({
      operation: 'session.sync',
      session: {
        sessionId: activeSessionId,
        kiloSessionId: ROOT_ID,
        directory: '/workspace/shared',
      },
      payload: {},
    });
    const questions = [
      { id: 'question_root', sessionID: ROOT_ID, questions: [{ question: 'Root?' }] },
      {
        id: 'question_child',
        sessionID: THIRD_ROOT_ID,
        rootKiloSessionId: ROOT_ID,
        questions: [{ question: 'Child?' }],
      },
    ];
    const permissions = [
      { id: 'permission_root', sessionID: ROOT_ID },
      { id: 'permission_child', sessionID: THIRD_ROOT_ID, rootKiloSessionId: ROOT_ID },
    ];
    respondToWrapperRequest(wrapper, sync, {
      status: { type: 'busy' },
      questions: [
        ...questions,
        { id: 'question_sibling', sessionID: SECOND_ROOT_ID },
        { id: 'question_contradictory', sessionID: ROOT_ID, rootKiloSessionId: SECOND_ROOT_ID },
      ],
      permissions: [
        ...permissions,
        { id: 'permission_sibling', sessionID: SECOND_ROOT_ID },
        { id: 'permission_contradictory', sessionID: ROOT_ID, rootKiloSessionId: SECOND_ROOT_ID },
      ],
    });
    const activeResponse = await pendingActiveResponse;
    if (activeResponse.status !== 101 || !activeResponse.webSocket) {
      throw new Error(`Unexpected active-session stream status: ${activeResponse.status}`);
    }
    activeResponse.webSocket.accept();
    const events = (await nextMessages(activeResponse.webSocket, 8)).map(
      message => JSON.parse(message) as SessionStreamEvent
    );
    expect(events.map(event => event.streamEventType)).toEqual([
      'kilocode',
      'connected',
      'kilocode',
      'kilocode',
      'kilocode',
      'kilocode',
      'cloud.message.queued',
      'cloud.message.sent',
    ]);
    expect(events[1]?.data).toMatchObject({
      cloudStatus: { type: 'ready' },
      activeMessageId: INITIAL_MESSAGE_ID,
      pendingInteractions: { questions, permissions },
    });
    expect(events.slice(2, 4)).toEqual(
      questions.map(question =>
        expect.objectContaining({
          eventId: 0,
          sessionId: activeSessionId,
          data: { type: 'question.asked', event: 'question.asked', properties: question },
        })
      )
    );
    expect(events.slice(4, 6)).toEqual(
      permissions.map(permission =>
        expect.objectContaining({
          eventId: 0,
          sessionId: activeSessionId,
          data: { type: 'permission.asked', event: 'permission.asked', properties: permission },
        })
      )
    );
    await runInDurableObject(active, async (_instance, state) => {
      expect(await state.storage.get('session_pending_interactions')).toMatchObject({
        questions,
        permissions,
      });
      expect(await state.storage.get('session_messages')).toEqual([
        expect.objectContaining({ messageId: INITIAL_MESSAGE_ID, state: 'accepted' }),
      ]);
    });
    await runInDurableObject(control, async instance => {
      expect(await instance.listRoutes()).toEqual([
        expect.objectContaining({ sessionId: activeSessionId, kiloSessionId: ROOT_ID }),
      ]);
    });
    await runInDurableObject(empty, async (_instance, state) => {
      expect(await state.storage.get('session_messages')).toBeUndefined();
    });

    activeResponse.webSocket.close();
    emptyResponse.webSocket.close();
    wrapper.close();
  });
});

describe('SandboxControl Vercel runtime identity', () => {
  const ownerId = 'user_vercel_rotation';
  const originalLocator: VercelProviderLocator = {
    teamId: 'team_original',
    projectId: 'project_original',
    snapshotId: 'snapshot_original',
    runtimeBuildId: 'build_original',
    runtime: 'node24',
  };
  const currentLocator: VercelProviderLocator = {
    teamId: 'team_current',
    projectId: 'project_current',
    snapshotId: 'snapshot_current',
    runtimeBuildId: 'build_current',
    runtime: 'node24',
  };

  function runtimeEnv(locator: VercelProviderLocator) {
    return {
      VERCEL_TOKEN: 'test-vercel-token',
      VERCEL_TEAM_ID: locator.teamId,
      VERCEL_PROJECT_ID: locator.projectId,
      VERCEL_SANDBOX_SNAPSHOT_ID: locator.snapshotId,
      VERCEL_SANDBOX_RUNTIME_BUILD_ID: locator.runtimeBuildId,
      VERCEL_SANDBOX_RUNTIME: locator.runtime,
      VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
      VERCEL_SANDBOX_EXTEND_DURATION_MS: '120000',
      WORKER_URL: 'https://worker.test',
      KILOCODE_BACKEND_BASE_URL: CONTAINMENT_TARGETS.backendBaseUrl,
      KILO_OPENROUTER_BASE: CONTAINMENT_TARGETS.providerBaseUrl,
      KILO_SESSION_INGEST_URL: CONTAINMENT_TARGETS.sessionIngestBaseUrl,
      GIT_TOKEN_SERVICE: fakeCredentialBroker().binding,
    };
  }

  function providerEnvelope(name: string, locator: VercelProviderLocator, intentId: string) {
    return {
      sandbox: {
        name,
        currentSessionId: 'vsess_1',
        status: 'running',
        persistent: false,
        createdAt: 1,
        updatedAt: 1,
        tags: {
          'kilo-managed-by': 'cloud-agent-session',
          'kilo-create-operation': intentId,
          'kilo-runtime-build': locator.runtimeBuildId,
        },
      },
      session: {
        id: 'vsess_1',
        sourceSandboxName: name,
        projectId: locator.projectId,
        sourceSnapshotId: locator.snapshotId,
        runtime: locator.runtime,
        status: 'running',
        memory: 2048,
        vcpus: 2,
        region: 'iad1',
        timeout: 300000,
        requestedAt: 1,
        cwd: '/',
        createdAt: 1,
        updatedAt: 1,
      },
      routes: [],
    };
  }

  async function seedRuntime(physicalState: 'stopped' | 'running' | 'creating' | 'failed') {
    const name = `ses-${crypto.randomUUID().replaceAll('-', '')}` as const;
    const stub = env.SANDBOX_CONTROL.getByName(name);
    await env.SANDBOX_SESSION.getByName(`${ownerId}:${GRANT_SESSION_ID}`).registerSession({
      identity: { sessionId: GRANT_SESSION_ID, userId: ownerId },
      auth: { kiloSessionId: ROOT_ID, kilocodeToken: KILO_TOKEN },
      agent: {},
      workspace: {
        sandboxId: name,
        sandboxProvider: 'vercel',
        workspacePath: '/workspace/contained',
      },
    });
    await runInDurableObject(stub, async (instance, state) => {
      const originalEnv = instance['env'];
      Object.assign(instance, { env: { ...originalEnv, ...runtimeEnv(originalLocator) } });
      try {
        await instance.ensureReady({
          ownerId,
          sessionId: GRANT_SESSION_ID,
          provider: 'vercel',
          allowCreate: false,
        });
        const physical = await instance.claimCreate(
          'intent_original',
          false,
          name,
          WORKTREE_CREDENTIAL_CONTAINMENT
        );
        if (!physical.createIntent) throw new Error('Missing persisted create intent');
        await savePhysicalRecord(state.storage, {
          ...physical,
          createIntent: {
            ...physical.createIntent,
            createdAt: Date.now() - DEADLINE_MS.createSettle - 1,
          },
        });
        if (physicalState !== 'creating') {
          await instance.confirmInstance(
            encodeVercelProviderRef({ sandboxName: name, sessionId: 'vsess_1' })
          );
          if (physicalState === 'stopped') {
            await instance.beginStop('idle');
            await instance.confirmStopped();
          } else if (physicalState === 'failed') {
            await instance.markFailed();
          }
        }
        expect(await state.storage.get('provider_locator')).toEqual(originalLocator);
      } finally {
        Object.assign(instance, { env: originalEnv });
      }
    });
    await abortAllDurableObjects();
    return { name, stub: env.SANDBOX_CONTROL.getByName(name) };
  }

  it.each(['stopped', 'failed'] as const)(
    'creates from the current image after a %s runtime and config rotation',
    async physicalState => {
      const { name, stub } = await seedRuntime(physicalState);
      await runInDurableObject(stub, async (instance, state) => {
        const originalEnv = instance['env'];
        Object.assign(instance, { env: { ...originalEnv, ...runtimeEnv(currentLocator) } });
        const requests: Request[] = [];
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          const pathname = new URL(request.url).pathname;
          if (pathname.endsWith('/stop')) {
            return Response.json({
              session: {
                ...providerEnvelope(name, originalLocator, 'intent_original').session,
                status: 'stopped',
              },
            });
          }
          if (pathname === '/v2/sandboxes') {
            const physical = await instance.getPhysicalRecord();
            expect(physical.state).toBe('creating');
            expect(await state.storage.get('provider_locator')).toEqual(currentLocator);
            if (!physical.createIntent?.allocationName)
              throw new Error('Missing persisted create intent');
            return Response.json(
              providerEnvelope(
                physical.createIntent.allocationName,
                currentLocator,
                physical.createIntent.intentId
              )
            );
          }
          if (pathname.endsWith('/network-policy')) {
            const physical = await instance.getPhysicalRecord();
            if (!physical.createIntent?.allocationName)
              throw new Error('Missing persisted create intent');
            return Response.json({
              session: providerEnvelope(
                physical.createIntent.allocationName,
                currentLocator,
                physical.createIntent.intentId
              ).session,
            });
          }
          if (pathname.endsWith('/cmd')) {
            return Response.json({
              command: {
                id: 'cmd_1',
                name: 'sh',
                args: [],
                cwd: '/',
                sessionId: 'vsess_1',
                exitCode: null,
                startedAt: 1,
              },
            });
          }
          throw new Error(`Unexpected provider request: ${pathname}`);
        });
        try {
          await expect(
            instance.ensureReady({
              ownerId,
              sessionId: GRANT_SESSION_ID,
              provider: 'vercel',
              allowCreate: true,
            })
          ).resolves.toMatchObject({ physical: 'running' });
          const create = requests.find(
            request => new URL(request.url).pathname === '/v2/sandboxes'
          );
          if (!create) throw new Error('Missing provider create request');
          expect(new URL(create.url).searchParams.get('teamId')).toBe(currentLocator.teamId);
          await expect(create.json()).resolves.toMatchObject({
            projectId: currentLocator.projectId,
            source: { type: 'snapshot', snapshotId: currentLocator.snapshotId },
            runtime: currentLocator.runtime,
            tags: { 'kilo-runtime-build': currentLocator.runtimeBuildId },
          });
          expect(await state.storage.get('provider_locator')).toEqual(currentLocator);
          if (physicalState === 'failed') {
            expect(new URL(requests[0].url).pathname).toBe('/v2/sandboxes/sessions/vsess_1/stop');
            expect(new URL(requests[0].url).searchParams.get('teamId')).toBe(
              originalLocator.teamId
            );
          }
        } finally {
          fetchMock.mockRestore();
          Object.assign(instance, { env: originalEnv });
        }
      });
    }
  );

  it.each(['running', 'creating'] as const)(
    'preserves the original locator for %s runtime recovery and cleanup after config rotation',
    async physicalState => {
      const { name, stub } = await seedRuntime(physicalState);
      await runInDurableObject(stub, async (instance, state) => {
        const originalEnv = instance['env'];
        Object.assign(instance, { env: { ...originalEnv, ...runtimeEnv(currentLocator) } });
        const requests: URL[] = [];
        const originalEnvelope = providerEnvelope(name, originalLocator, 'intent_original');
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = new URL(new Request(input, init).url);
          requests.push(url);
          if (url.pathname === `/v2/sandboxes/${name}`) {
            return Response.json({ ...originalEnvelope, resumed: false });
          }
          if (url.pathname === '/v2/sandboxes/sessions/vsess_1/stop') {
            return Response.json({ session: { ...originalEnvelope.session, status: 'stopped' } });
          }
          if (url.pathname === '/v2/sandboxes/sessions/vsess_1/network-policy') {
            return Response.json({ session: originalEnvelope.session });
          }
          throw new Error(`Unexpected provider request: ${url.pathname}`);
        });
        try {
          await expect(
            instance.ensureReady({
              ownerId,
              sessionId: GRANT_SESSION_ID,
              provider: 'vercel',
              allowCreate: false,
            })
          ).resolves.toMatchObject({ physical: physicalState });
          expect(requests.map(url => url.pathname)).toEqual(
            physicalState === 'running' ? ['/v2/sandboxes/sessions/vsess_1/network-policy'] : []
          );
          await expect(instance.claimCreate('intent_replacement')).rejects.toThrow(
            `claimCreate from ${physicalState}`
          );
          expect(await state.storage.get('provider_locator')).toEqual(originalLocator);
          if (physicalState === 'creating') {
            const physical = await instance.getPhysicalRecord();
            const provider = instance['provider'];
            if (!physical.createIntent) throw new Error('Missing create recovery');
            const resolved = await provider.observe(physical.providerRef, physical.createIntent);
            if (!resolved.providerRef) throw new Error('Original creation was not recovered');
            expect(resolved.status).toBe('active');
            await instance.confirmInstance(resolved.providerRef);
            expect(requests[0].searchParams.get('projectId')).toBe(originalLocator.projectId);
            expect(requests[0].searchParams.get('resume')).toBe('false');
          }
          await saveDeadlines(state.storage, { idleStop: Date.now() - 1 });
          await instance.alarm();
          await expect(instance.getPhysicalRecord()).resolves.toMatchObject({ state: 'stopped' });
          expect(await state.storage.get('provider_locator')).toEqual(originalLocator);
          expect(requests.map(url => url.pathname)).toEqual([
            ...(physicalState === 'creating'
              ? [`/v2/sandboxes/${name}`]
              : ['/v2/sandboxes/sessions/vsess_1/network-policy']),
            '/v2/sandboxes/sessions/vsess_1/stop',
          ]);
          expect(
            requests.every(url => url.searchParams.get('teamId') === originalLocator.teamId)
          ).toBe(true);
        } finally {
          fetchMock.mockRestore();
          Object.assign(instance, { env: originalEnv });
        }
      });
    }
  );
});

describe('SandboxSession targeted deletion', () => {
  it('detaches the deleted root before removing metadata and preserves sibling state', async () => {
    const ownerId = 'user_grouped_delete';
    const sessionA = GRANT_SESSION_ID;
    const sessionB = SECOND_GRANT_SESSION_ID;
    const targetSandboxId = 'usr-abcdef123405';
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await instance.claimCreate(
        'intent_routes',
        false,
        undefined,
        WORKTREE_CREDENTIAL_CONTAINMENT
      );
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(sessionA, ROOT_ID, ownerId)
      );
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(sessionB, SECOND_ROOT_ID, ownerId)
      );
    });
    const first = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionA}`);
    const second = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionB}`);
    await runInDurableObject(first, instance =>
      instance.registerSession(
        groupedRegistration({
          ownerId,
          sessionId: sessionA,
          kiloSessionId: ROOT_ID,
          sandboxId: targetSandboxId,
        })
      )
    );
    await runInDurableObject(second, instance =>
      instance.registerSession(
        groupedRegistration({
          ownerId,
          sessionId: sessionB,
          kiloSessionId: SECOND_ROOT_ID,
          sandboxId: targetSandboxId,
        })
      )
    );

    await runInDurableObject(second, instance => instance.deleteSession());

    await runInDurableObject(control, async instance => {
      expect(await instance.listRoutes()).toEqual([
        expect.objectContaining({ sessionId: sessionA, kiloSessionId: ROOT_ID }),
      ]);
    });
    await runInDurableObject(first, async instance => {
      expect((await instance.getMetadata())?.identity.sessionId).toBe(sessionA);
    });
    await runInDurableObject(second, async instance => {
      await expect(instance.getMetadata()).resolves.toBeNull();
    });
  });

  it('revokes credentials on failed detach and resumes public deletion without exposing fenced metadata or deleting sibling state', async () => {
    const ownerId = 'user_grouped_delete_failed';
    const sessionId = GRANT_SESSION_ID;
    const siblingSessionId = SECOND_GRANT_SESSION_ID;
    const kiloSessionId = ROOT_ID;
    const siblingKiloSessionId = SECOND_ROOT_ID;
    const targetSandboxId = 'usr-abcdef123406';
    const credential = generateSandboxCredential();
    const control = env.SANDBOX_CONTROL.getByName(targetSandboxId);
    await seedRunningCredential(credential, targetSandboxId);
    await runInDurableObject(control, async instance => {
      await instance.initializeOwner(ownerId);
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(sessionId, kiloSessionId, ownerId)
      );
      await attachGrantedSession(
        instance,
        instance['ctx'],
        groupedRoute(siblingSessionId, siblingKiloSessionId, ownerId)
      );
    });
    const session = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    const sibling = env.SANDBOX_SESSION.getByName(`${ownerId}:${siblingSessionId}`);
    for (const [stub, rootSessionId, rootKiloSessionId] of [
      [session, sessionId, kiloSessionId],
      [sibling, siblingSessionId, siblingKiloSessionId],
    ] as const) {
      await stub.registerSession(
        groupedRegistration({
          ownerId,
          sessionId: rootSessionId,
          kiloSessionId: rootKiloSessionId,
          sandboxId: targetSandboxId,
        })
      );
      await stub.receiveSandboxControlEvent({
        identity: { directory: '/workspace/shared', kiloSessionId: rootKiloSessionId },
        payload: {
          type: 'message.updated',
          properties: { info: { id: INITIAL_MESSAGE_ID, sessionID: rootKiloSessionId } },
        },
      });
    }
    const siblingState = await runInDurableObject(sibling, async (_instance, state) => ({
      metadata: await state.storage.get('session_metadata'),
      events: persistedSessionEvents(state, ['kilocode']),
    }));
    const originalRoutes = await control.listRoutes();
    const siblingGrants = await runInDurableObject(control, async (_instance, state) =>
      (await loadSessionCredentialGrants(state.storage)).filter(grant =>
        grant.members.some(member => member.sessionId === siblingSessionId)
      )
    );
    expect(siblingGrants).toHaveLength(1);
    const authorization = vi.mocked(requireCurrentSessionAccess);
    authorization.mockResolvedValue({ kiloSessionId, organizationId: null });
    const caller = router(createSessionManagementHandlers()).createCaller({
      env,
      userId: ownerId,
      authToken: 'test-token',
      request: new Request('http://worker.test/trpc/deleteSession'),
    });

    const wrapper = await connect(credential, targetSandboxId);
    await completeHello(wrapper, 'hello-grouped-delete-failure', {
      providerInstanceId: cloudflareRef(targetSandboxId),
      wrapperInstanceId: crypto.randomUUID(),
    });
    signalWrapperReady(wrapper);
    await vi.waitFor(async () => {
      await expect(control.getStatus()).resolves.toMatchObject({ connection: 'ready' });
    });
    const requests: RequestFrame[] = [];
    let failDetach = true;
    wrapper.addEventListener('message', event => {
      const request = requestFrameSchema.parse(JSON.parse(String(event.data)));
      requests.push(request);
      wrapper.send(
        JSON.stringify({
          type: 'response',
          requestId: request.requestId,
          ...(request.operation === 'session.detach' && failDetach
            ? {
                ok: false,
                error: { code: 'not_ready', message: 'live detach failed', retryable: true },
              }
            : { ok: true }),
        })
      );
    });

    try {
      await expect(caller.deleteSession({ sessionId })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to clean up session metadata',
      });
      await runInDurableObject(session, async (instance, state) => {
        await expect(instance.getMetadata()).resolves.toBeNull();
        await expect(instance.getRuntimeLocation()).resolves.toMatchObject({
          cloudAgentSessionId: sessionId,
          sessionId: kiloSessionId,
          location: { sandboxId: targetSandboxId },
        });
        expect(await state.storage.get('session_metadata')).toMatchObject({
          identity: { sessionId },
        });
        expect(await state.storage.get('session_lifecycle_fence')).toMatchObject({
          state: 'deleted',
        });
        expect(persistedSessionEvents(state, ['kilocode'])).toHaveLength(1);
      });
      await expect(control.listRoutes()).resolves.toEqual(originalRoutes);
      await runInDurableObject(control, async (_instance, state) => {
        expect(await loadSessionCredentialGrants(state.storage)).toEqual(siblingGrants);
      });
      await expect(
        session.registerSession(
          groupedRegistration({
            ownerId,
            sessionId,
            kiloSessionId,
            sandboxId: targetSandboxId,
          })
        )
      ).resolves.toMatchObject({ success: false });

      const requestsBeforeRetry = requests.length;
      authorization.mockRejectedValueOnce(
        new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' })
      );
      await expect(caller.deleteSession({ sessionId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(requests).toHaveLength(requestsBeforeRetry);

      await expect(caller.deleteSession({ sessionId })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
      await expect(control.listRoutes()).resolves.toEqual(originalRoutes);
      await expect(session.getRuntimeLocation()).resolves.not.toBeNull();
      await runInDurableObject(control, async (_instance, state) => {
        expect(await loadSessionCredentialGrants(state.storage)).toEqual(siblingGrants);
      });

      failDetach = false;
      await expect(caller.deleteSession({ sessionId })).resolves.toEqual({ success: true });
      await expect(control.listRoutes()).resolves.toEqual(
        originalRoutes.filter(route => route.sessionId === siblingSessionId)
      );
      await expect(control.getPhysicalRecord()).resolves.toMatchObject({ state: 'running' });
      await runInDurableObject(control, async (_instance, state) => {
        expect(await loadSessionCredentialGrants(state.storage)).toEqual(siblingGrants);
      });
      await runInDurableObject(session, async (instance, state) => {
        await expect(instance.getRuntimeLocation()).resolves.toBeNull();
        expect(await state.storage.get('session_metadata')).toBeUndefined();
        expect(persistedSessionEvents(state, ['kilocode'])).toEqual([]);
        expect(await state.storage.get('session_lifecycle_fence')).toMatchObject({
          state: 'deleted',
        });
      });
      await expect(
        runInDurableObject(sibling, async (_instance, state) => ({
          metadata: await state.storage.get('session_metadata'),
          events: persistedSessionEvents(state, ['kilocode']),
        }))
      ).resolves.toEqual(siblingState);
      expect(requests.map(request => request.operation)).toEqual([
        'session.detach',
        'session.detach',
        'session.detach',
      ]);
      expect(requests.every(request => request.session?.kiloSessionId === kiloSessionId)).toBe(
        true
      );
      expect(authorization).toHaveBeenCalledTimes(4);

      await expect(caller.deleteSession({ sessionId })).resolves.toEqual({
        success: true,
        message: 'Session not found or already deleted',
      });
      expect(authorization).toHaveBeenCalledTimes(4);
      expect(requests).toHaveLength(3);
    } finally {
      wrapper.close();
      authorization.mockReset();
    }
  });
});
