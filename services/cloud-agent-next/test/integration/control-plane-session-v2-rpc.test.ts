import { env, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import { routes as sandboxRoutes } from '../../src/control-plane/sandbox/sqlite-schema.js';
import type {
  ControlPlaneSessionRegistration,
  SandboxSessionV2,
} from '../../src/control-plane/session/session-do.js';
import { events } from '../../src/db/sqlite-schema.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { getWorktreeWorkspacePath } from '../../src/workspace.js';
import type { ControlPlanePromptPayload } from '../../src/shared/control-plane-protocol.js';
import type { Env } from '../../src/types.js';
import {
  createFakeCredentialBroker,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const NATIVE_KILO_TOKEN = 'native-kilo-token-user';
const USER_ID = 'user_123';
const ORG_ID = 'org_123';
let sequence = 0;

function b64url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** A Kilo token that decodes to `runtimeAuthorization` (modern authorization). */
function runtimeAuthorizedKiloToken(): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ runtimeAuthorization: { id: 'ra_1' } }));
  return `${header}.${payload}.sig`;
}

function newSessionId(): string {
  sequence += 1;
  return `workspace_${crypto.randomUUID()}`;
}

function kiloSessionId(): string {
  // `containedKiloSessionIdSchema` requires exactly 26 alphanumerics.
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}

function messageId(): string {
  // `MessageIdSchema`: `msg_` + 12 lowercase hex + 14 base62.
  const hex = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
  return `msg_${hex}${suffix}`;
}

async function sealFor(sessionId: string, secret: string): Promise<string> {
  const now = Date.now();
  return sealRuntimeAuthorization(
    {
      version: 1,
      id: crypto.randomUUID(),
      resourceKind: 'cloud-agent-next',
      resourceId: sessionId,
      userId: USER_ID,
      authorizationUserId: USER_ID,
      organizationId: ORG_ID,
      issuedAt: new Date(now).toISOString(),
      delegationExpiresAt: new Date(now + 60 * 60_000).toISOString(),
      state: 'active',
      bindings: { userPepperDigest: 'null', authorizationPepperDigest: 'null' },
      source: { admissionSource: 'user' },
    },
    secret
  );
}

function metadata(input: {
  sessionId: string;
  kiloSessionId: string;
  sandboxId: string;
  sandboxProvider?: 'cloudflare' | 'vercel' | 'cloudflare-containers';
  kiloToken?: string;
  repository?: Record<string, string>;
  worktreeId?: string;
  workspacePath?: string;
}) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId,
      userId: USER_ID,
      orgId: ORG_ID,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: {
      kiloSessionId: input.kiloSessionId,
      kilocodeToken: input.kiloToken ?? NATIVE_KILO_TOKEN,
    },
    agent: { mode: 'code', model: 'test/model' },
    repository: input.repository ?? {
      type: 'github',
      repo: 'acme/widgets',
      upstreamBranch: 'main',
    },
    workspace: {
      branchName: 'kilo/test-branch',
      sandboxId: input.sandboxId,
      sandboxProvider: input.sandboxProvider ?? 'cloudflare',
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    },
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

function createFakeProvider(): { adapter: ProviderAdapter; createCalls: number } {
  const provider = { adapter: null as unknown as ProviderAdapter, createCalls: 0 };
  provider.adapter = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      provider.createCalls += 1;
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch() {
      return { startSource: 'image' as const };
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop() {
      return 'terminal' as StopResult;
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return provider;
}

async function installSandbox(
  sandboxId: string,
  provider: ProviderAdapter
): Promise<DurableObjectStub<SandboxControlV2>> {
  const sandboxStub = sandboxes.getByName(sandboxId);
  const broker = createFakeCredentialBroker();
  await runInDurableObject(sandboxStub, async instance => {
    await instance.getAllocationState();
    // Isolated sessions address their containment namespace by `ses-` prefix.
    installFakeCredentialEnv(instance.env, broker, {
      SandboxSmallContainment: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
      WORKER_URL: 'https://control.test',
      KILOCODE_BACKEND_BASE_URL: 'https://control.test',
      KILO_OPENROUTER_BASE: 'https://control.test',
      KILO_SESSION_INGEST_URL: 'https://control.test',
    });
    Object.assign(instance, { createProviderAdapter: () => provider, provider });
  });
  return sandboxStub;
}

async function readSandboxRouteRow(
  sandboxStub: DurableObjectStub<SandboxControlV2>,
  sessionId: string
): Promise<{ spec: Record<string, unknown>; state: string }> {
  return runInDurableObject(sandboxStub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    const rows = await db.select().from(sandboxRoutes);
    const row = rows.find(candidate => candidate.session_id === sessionId);
    if (!row) throw new Error(`No sandbox route for ${sessionId}`);
    return { spec: JSON.parse(row.spec) as Record<string, unknown>, state: row.state };
  });
}

async function readRegistration(stub: DurableObjectStub<SandboxSessionV2>): Promise<
  | {
      sandboxId: string;
      spec: Record<string, unknown>;
      sandboxSelection?: { provider: string; allocationName?: string };
    }
  | undefined
> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get('control_plane_session'));
}

afterEach(async () => {
  await reset();
});

describe('SandboxSessionV2 worker RPC surface', () => {
  it('records the Worker selection, carries it to the sandbox pin, and admits the turn', async () => {
    const sessionId = newSessionId();
    const kiloId = kiloSessionId();
    // A deliberately different sandbox id than the DO would derive for this
    // session: proves the DO records the given selection and never re-derives (H2).
    const providedSandboxId = await generateSandboxId('*', ORG_ID, USER_ID, 'other_session');
    const provider = createFakeProvider();
    const sandboxStub = await installSandbox(providedSandboxId, provider.adapter);

    const sessionStub = sessions.getByName(sessionId);
    const firstMessageId = messageId();
    const result = await sessionStub.createSessionWithInitialAdmission({
      metadata: metadata({
        sessionId,
        kiloSessionId: kiloId,
        sandboxId: providedSandboxId,
        sandboxProvider: 'vercel',
        kiloToken: runtimeAuthorizedKiloToken(),
        // A generic git remote avoids the direct managed-GitHub path, which the
        // Vercel pin does not use (it has no outbound credential proxy).
        repository: {
          type: 'git',
          url: 'https://github.com/acme/widgets.git',
          platform: 'github',
        },
      }),
      message: promptPayload(firstMessageId),
      sandboxSelection: { provider: 'vercel', allocationName: 'alloc_test' },
    });

    // M2: legacy admission ack shape.
    expect(result).toEqual({
      success: true,
      outcome: 'queued',
      messageId: firstMessageId,
      compatibilityDelivery: 'queued',
    });

    // H2: the provided sandbox id is used verbatim.
    const registration = await readRegistration(sessionStub);
    expect(registration?.sandboxId).toBe(providedSandboxId);
    expect(registration?.sandboxSelection).toMatchObject({
      provider: 'vercel',
      allocationName: 'alloc_test',
    });
    // Low: the raw Kilo token never reaches the route spec.
    expect(
      (registration?.spec.env as Record<string, string> | undefined)?.KILOCODE_TOKEN
    ).toBeUndefined();

    // The session is prepared.
    await expect(sessionStub.getSession()).resolves.toMatchObject({
      type: 'found',
      route: { state: 'preparing' },
      messages: [{ messageId: firstMessageId, state: 'queued' }],
    });

    // H1: the non-default provider/allocation reached the sandbox pin.
    await expect(sandboxStub.getProviderRuntime()).resolves.toEqual({
      provider: 'vercel',
      allocationName: 'alloc_test',
    });
    expect(provider.createCalls).toBe(1);

    // The registered route spec carries the issued credential handle/scope, and
    // M1: modern authorization requests per-session runtime isolation.
    const row = await readSandboxRouteRow(sandboxStub, sessionId);
    expect(row.state).toBe('preparing');
    expect(row.spec.runtimeIsolation).toBe('per-session');
    const kilo = row.spec.kilo as { token?: string; scopeId?: string } | undefined;
    expect(typeof kilo?.token).toBe('string');
    expect((kilo?.token ?? '').length).toBeGreaterThan(0);
    expect(kilo?.scopeId).toBe(sessionId);
  });

  it('registers a worktree sibling from metadata through the DO', async () => {
    const sessionId = newSessionId();
    const siblingId = newSessionId();
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const identityPath = getWorktreeWorkspacePath(ORG_ID, USER_ID, worktreeId);
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const sandboxStub = await installSandbox(sandboxId, provider.adapter);

    const startStub = sessions.getByName(sessionId);
    await startStub.createSessionWithInitialAdmission({
      metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId, worktreeId }),
      message: promptPayload(messageId()),
      sandboxSelection: { provider: 'cloudflare' },
    });

    // H3: the sibling registers through the DO, which builds the registration.
    const siblingStub = sessions.getByName(siblingId);
    const siblingResult = await siblingStub.registerSessionFromMetadata({
      metadata: metadata({
        sessionId: siblingId,
        kiloSessionId: kiloSessionId(),
        sandboxId,
        worktreeId,
        workspacePath: identityPath,
      }),
      sandboxSelection: { provider: 'cloudflare' },
    });
    expect(siblingResult).toEqual({ success: true });

    // The sibling prepares on the same sandbox once it has a message.
    await siblingStub.send(promptPayload(messageId()));

    const siblingRegistration = await readRegistration(siblingStub);
    expect(siblingRegistration?.sandboxId).toBe(sandboxId);
    expect(siblingRegistration?.spec.directory).toBe('/workspace/app');
    // scopeId follows the worktree id.
    expect(
      (await readSandboxRouteRow(sandboxStub, siblingId)).spec.kilo as { scopeId?: string }
    ).toMatchObject({ scopeId: worktreeId });

    // H3: grouped metadata is stored and readable.
    const stored = await siblingStub.getMetadata();
    expect(stored?.identity.sessionId).toBe(siblingId);
    expect(stored?.workspace?.worktreeId).toBe(worktreeId);
    // The stored metadata keeps the identity worktree path; only the route spec
    // directory is the isolated checkout.
    expect(stored?.workspace?.workspacePath).toBe(identityPath);
  });

  it('replays a repeated sibling register and rejects a changed intent (N3)', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const otherSandboxId = await generateSandboxId('*', ORG_ID, USER_ID, `${sessionId}_other`);
    const secret = 'test-nextauth-secret';
    const seal = await sealFor(sessionId, secret);
    const storedDirectory = getWorktreeWorkspacePath(
      ORG_ID,
      USER_ID,
      `worktree_${crypto.randomUUID()}`
    );

    const sessionStub = sessions.getByName(sessionId);
    const peer = new FakeSandboxPeer();
    await runInDurableObject(sessionStub, instance => {
      instance.env.NEXTAUTH_SECRET = secret;
      instance.sandboxPeerFor = () => peer;
    });

    const input = (id: string, sbx: string) => ({
      metadata: metadata({
        sessionId: id,
        kiloSessionId: kiloSessionId(),
        sandboxId: sbx,
        kiloToken: runtimeAuthorizedKiloToken(),
      }),
      sandboxSelection: { provider: 'cloudflare' as const },
      runtimeAuthorizationSeal: seal,
    });

    // The first register stores the seal; the repeat must replay success before
    // touching the seal (a naive unseal would fail "already installed").
    await expect(
      sessionStub.registerSessionFromMetadata(input(sessionId, sandboxId))
    ).resolves.toEqual({ success: true });

    // Seed a registration whose directory predates this change; a replay must
    // keep that stored directory rather than rebuilding the isolated one.
    await runInDurableObject(sessionStub, async (instance, state) => {
      const stored =
        await state.storage.get<ControlPlaneSessionRegistration>('control_plane_session');
      if (!stored) throw new Error('expected a stored registration');
      await instance.registerSession({
        ...stored,
        spec: { ...stored.spec, directory: storedDirectory },
      });
    });

    await expect(
      sessionStub.registerSessionFromMetadata(input(sessionId, sandboxId))
    ).resolves.toEqual({ success: true });
    await expect(readRegistration(sessionStub)).resolves.toMatchObject({
      spec: { directory: storedDirectory },
    });

    // A subsequent prepare frame carries the stored old directory.
    await sessionStub.send(promptPayload(messageId()));
    expect(peer.prepareCalls[0]?.spec.directory).toBe(storedDirectory);

    // A changed sandbox id is a different intent.
    await expect(
      sessionStub.registerSessionFromMetadata(input(sessionId, otherSandboxId))
    ).resolves.toMatchObject({
      success: false,
      code: 'BAD_REQUEST',
      failureBoundary: 'registration',
    });
  });

  it('replays a repeated create and rejects a different initial messageId', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    await installSandbox(sandboxId, provider.adapter);
    const sessionStub = sessions.getByName(sessionId);
    const first = messageId();
    const second = messageId();
    const createInput = (id: string) => ({
      metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
      message: promptPayload(id),
      sandboxSelection: { provider: 'cloudflare' as const },
    });

    await expect(
      sessionStub.createSessionWithInitialAdmission(createInput(first))
    ).resolves.toMatchObject({ success: true, messageId: first });

    // M3: same identity/repository/sandbox/message replays.
    await expect(
      sessionStub.createSessionWithInitialAdmission(createInput(first))
    ).resolves.toMatchObject({ success: true, messageId: first });

    // M3: a different initial messageId is rejected.
    await expect(
      sessionStub.createSessionWithInitialAdmission(createInput(second))
    ).resolves.toMatchObject({
      success: false,
      code: 'BAD_REQUEST',
      failureBoundary: 'registration',
    });
  });

  it('rejects invalid create input with the legacy failure shape (M2)', async () => {
    const sessionStub = sessions.getByName(newSessionId());
    const result = await sessionStub.createSessionWithInitialAdmission({
      // Missing sandboxSelection fails the input schema.
      metadata: metadata({
        sessionId: newSessionId(),
        kiloSessionId: kiloSessionId(),
        sandboxId: await generateSandboxId('*', ORG_ID, USER_ID, 'input'),
      }),
      message: promptPayload(messageId()),
    } as never);
    expect(result).toEqual({
      success: false,
      code: 'BAD_REQUEST',
      error: 'Invalid session create input',
      failureBoundary: 'registration',
    });
  });

  it('rejects a selection that disagrees with the metadata provider (N2)', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const sessionStub = sessions.getByName(sessionId);

    await expect(
      sessionStub.createSessionWithInitialAdmission({
        metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
        message: promptPayload(messageId()),
        sandboxSelection: { provider: 'vercel' },
      })
    ).resolves.toEqual({
      success: false,
      code: 'BAD_REQUEST',
      error: 'Sandbox selection provider does not match session metadata',
      failureBoundary: 'registration',
    });

    // The selection's own configuration must not contradict its provider.
    await expect(
      sessionStub.createSessionWithInitialAdmission({
        metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
        message: promptPayload(messageId()),
        sandboxSelection: { provider: 'cloudflare', configuration: { provider: 'vercel' } },
      })
    ).resolves.toMatchObject({
      success: false,
      code: 'BAD_REQUEST',
      failureBoundary: 'registration',
    });
  });

  it('rejects stored metadata that fails validation (Low)', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const sessionStub = sessions.getByName(sessionId);
    // A prompt payload accepts a loose messageId, but the metadata
    // `initialMessage.id` pattern does not: the stored-metadata validation must
    // reject it rather than throwing or storing it.
    await expect(
      sessionStub.createSessionWithInitialAdmission({
        metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
        message: promptPayload('m1'),
        sandboxSelection: { provider: 'cloudflare' },
      })
    ).resolves.toEqual({
      success: false,
      code: 'BAD_REQUEST',
      error: 'Invalid session metadata',
      failureBoundary: 'registration',
    });
  });

  it('stores a runtime authorization seal and resolves unknown handles to null (H4)', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const secret = 'test-nextauth-secret';
    const seal = await sealFor(sessionId, secret);

    const sessionStub = sessions.getByName(sessionId);
    await runInDurableObject(sessionStub, instance => {
      instance.env.NEXTAUTH_SECRET = secret;
      instance.sandboxPeerFor = () => new FakeSandboxPeer();
    });

    await expect(
      sessionStub.createSessionWithInitialAdmission({
        metadata: metadata({
          sessionId,
          kiloSessionId: kiloSessionId(),
          sandboxId,
          kiloToken: runtimeAuthorizedKiloToken(),
        }),
        message: promptPayload(messageId()),
        sandboxSelection: { provider: 'cloudflare' },
        runtimeAuthorizationSeal: seal,
      })
    ).resolves.toMatchObject({ success: true });

    const storedAuthorization = await runInDurableObject(sessionStub, (_instance, state) =>
      state.storage.get<{ state?: string }>('runtime_authorization')
    );
    expect(storedAuthorization?.state).toBe('active');

    // R1 mints on the Sandbox DO at the connected `session.prepare`; resolution
    // of an unknown handle is still null.
    await expect(
      sessionStub.resolveRuntimeCredentialProxyGrant('not-a-handle')
    ).resolves.toBeNull();
  });

  it('reads the latest assistant message for the session Kilo session', async () => {
    const sessionId = newSessionId();
    const kiloId = kiloSessionId();
    const otherKiloId = kiloSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const sessionStub = sessions.getByName(sessionId);
    await runInDurableObject(sessionStub, instance => {
      instance.sandboxPeerFor = () => new FakeSandboxPeer();
    });
    await sessionStub.registerSessionFromMetadata({
      metadata: metadata({ sessionId, kiloSessionId: kiloId, sandboxId }),
      sandboxSelection: { provider: 'cloudflare' },
    });

    const assistant = (id: string, sessionID: string) =>
      JSON.stringify({
        event: 'message.updated',
        properties: { info: { id, role: 'assistant', sessionID } },
      });
    await runInDurableObject(sessionStub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db.insert(events).values([
        {
          execution_id: 'exec_1',
          session_id: sessionId,
          stream_event_type: 'kilocode',
          payload: assistant('msg_1', kiloId),
          timestamp: 1,
          entity_id: 'message/msg_1',
        },
        {
          execution_id: 'exec_1',
          session_id: sessionId,
          stream_event_type: 'kilocode',
          payload: assistant('msg_other', otherKiloId),
          timestamp: 2,
          entity_id: 'message/msg_other',
        },
        {
          execution_id: 'exec_1',
          session_id: sessionId,
          stream_event_type: 'kilocode',
          payload: assistant('msg_2', kiloId),
          timestamp: 3,
          entity_id: 'message/msg_2',
        },
      ]);
    });

    await expect(sessionStub.getLatestAssistantMessage()).resolves.toMatchObject({
      info: { id: 'msg_2', role: 'assistant' },
      parts: [],
    });
  });

  it('returns null for the latest assistant message when the session is unregistered', async () => {
    const sessionStub = sessions.getByName(newSessionId());
    await expect(sessionStub.getLatestAssistantMessage()).resolves.toBeNull();
  });
});
