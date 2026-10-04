import { env, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallbackJob } from '../../src/callbacks/types.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { controlPlaneMessages } from '../../src/control-plane/session/sqlite-schema.js';
import { events } from '../../src/db/sqlite-schema.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { sessionRuntimeLocator } from '../../src/sandbox-control/worktree-ownership.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import type { ControlPlanePromptPayload } from '../../src/shared/control-plane-protocol.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';

type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_c1a';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const NATIVE_KILO_TOKEN = 'native-kilo-token-user';
const WORKER_URL = 'https://management.test';

function newSessionId(): string {
  return `workspace_${crypto.randomUUID()}`;
}

function kiloSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}

function messageId(): string {
  const hex = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
  return `msg_${hex}${suffix}`;
}

function worktreeId(): string {
  return `worktree_${crypto.randomUUID()}`;
}

function b64url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** A Kilo token that decodes to `runtimeAuthorization` (modern authorization). */
function runtimeAuthorizedKiloToken(): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ runtimeAuthorization: { id: 'ra_1' } }));
  return `${header}.${payload}.sig`;
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
  kiloToken?: string;
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
    repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
    callback: { target: { url: 'https://callback.test/hook' } },
    workspace: {
      branchName: 'kilo/test-branch',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare',
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function promptPayload(id: string): ControlPlanePromptPayload {
  return {
    messageId: id,
    turn: { type: 'prompt', prompt: 'hello' },
    agent: { mode: 'code', model: 'test/model' },
  };
}

/** Installs a fake Sandbox peer so the Session DO never needs a real sandbox. */
async function installPeer(
  stub: DurableObjectStub<SandboxSessionV2>,
  peer: FakeSandboxPeer
): Promise<void> {
  await runInDurableObject(stub, instance => {
    instance.env.WORKER_URL = WORKER_URL;
    instance.sandboxPeerFor = () => peer;
  });
}

type Captured = { reports: CloudAgentQueueReport[]; callbacks: CallbackJob[] };

/** Replaces both outbound queues with captures the DO reads lazily. */
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

async function registerSession(input: {
  sessionId: string;
  sandboxId: string;
  kiloSessionId: string;
  worktreeId?: string;
  workspacePath?: string;
}): Promise<DurableObjectStub<SandboxSessionV2>> {
  const stub = sessions.getByName(input.sessionId);
  const peer = new FakeSandboxPeer();
  await installPeer(stub, peer);
  await stub.registerSessionFromMetadata({
    metadata: metadata(input),
    sandboxSelection: { provider: 'cloudflare' },
  });
  return stub;
}

afterEach(async () => {
  await reset();
});

describe('SandboxSessionV2 management and worktree-deletion RPCs (C1a)', () => {
  it('reads the stored runtime location and returns null when unregistered', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const stub = await registerSession({
      sessionId,
      sandboxId,
      kiloSessionId: kiloSessionId(),
    });

    const metadata = await stub.getMetadata();
    expect(metadata).not.toBeNull();
    expect(sessionRuntimeLocator(metadata!)).toMatchObject({
      cloudAgentSessionId: sessionId,
      kiloUserId: USER_ID,
      organizationId: ORG_ID,
      location: { sandboxId, provider: 'cloudflare' },
    });

    await expect(sessions.getByName(newSessionId()).getMetadata()).resolves.toBeNull();
  });

  it('reports message work from the session snapshot', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const stub = sessions.getByName(sessionId);
    const peer = new FakeSandboxPeer();
    await installPeer(stub, peer);
    const first = messageId();
    await stub.createSessionWithInitialAdmission({
      metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
      message: promptPayload(first),
      sandboxSelection: { provider: 'cloudflare' },
    });

    // The route is preparing, so the admitted message stays queued.
    await expect(stub.getSession()).resolves.toMatchObject({
      type: 'found',
      messages: [{ messageId: first, state: 'queued' }],
    });

    // A ready route delivers the queued message, which becomes accepted.
    peer.prepareView = peer.view('ready');
    await stub.onRoute(peer.view('ready'));
    await expect(stub.getSession()).resolves.toMatchObject({
      type: 'found',
      messages: [{ messageId: first, state: 'accepted' }],
    });
  });

  it('returns the latest stored event id on the session snapshot', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const stub = await registerSession({
      sessionId,
      sandboxId,
      kiloSessionId: kiloSessionId(),
    });

    await expect(stub.getSession()).resolves.toMatchObject({ latestEventId: null });

    const insertedId = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const [row] = await db
        .insert(events)
        .values({
          execution_id: '',
          session_id: sessionId,
          stream_event_type: 'kilocode',
          payload: JSON.stringify({ type: 'session.idle', properties: {} }),
          timestamp: 5,
        })
        .returning({ id: events.id });
      return row?.id ?? null;
    });

    await expect(stub.getSession()).resolves.toMatchObject({ latestEventId: insertedId });
  });

  it('reads the stored runtime-authorization status', async () => {
    const secret = 'test-nextauth-secret';

    // No stored authorization and a non-modern token: legacy.
    const legacySession = newSessionId();
    const legacyStub = await registerSession({
      sessionId: legacySession,
      sandboxId: await generateSandboxId('*', ORG_ID, USER_ID, legacySession),
      kiloSessionId: kiloSessionId(),
    });
    await expect(legacyStub.getRuntimeAuthorizationStatus()).resolves.toMatchObject({
      state: 'legacy',
    });

    // A modern token with no stored authorization is revoked, not legacy.
    const revokedSession = newSessionId();
    const revokedStub = sessions.getByName(revokedSession);
    await installPeer(revokedStub, new FakeSandboxPeer());
    const registration = await revokedStub.registerSessionFromMetadata({
      metadata: metadata({
        sessionId: revokedSession,
        kiloSessionId: kiloSessionId(),
        sandboxId: await generateSandboxId('*', ORG_ID, USER_ID, revokedSession),
        kiloToken: runtimeAuthorizedKiloToken(),
      }),
      sandboxSelection: { provider: 'cloudflare' },
    });
    expect(registration).toEqual({ success: true });
    await expect(revokedStub.getRuntimeAuthorizationStatus()).resolves.toMatchObject({
      state: 'revoked',
    });
    await expect(
      runInDurableObject(revokedStub, instance => instance.getRuntimeToken())
    ).rejects.toThrow('Runtime authorization has been revoked');

    // A stored active authorization is active; an expired one is revoked.
    const activeSession = newSessionId();
    const activeSandbox = await generateSandboxId('*', ORG_ID, USER_ID, activeSession);
    const activeSeal = await sealFor(activeSession, secret);
    const activeStub = sessions.getByName(activeSession);
    await runInDurableObject(activeStub, instance => {
      instance.env.NEXTAUTH_SECRET = secret;
      instance.env.WORKER_URL = WORKER_URL;
      instance.sandboxPeerFor = () => new FakeSandboxPeer();
    });
    const admission = await activeStub.createSessionWithInitialAdmission({
      metadata: metadata({
        sessionId: activeSession,
        kiloSessionId: kiloSessionId(),
        sandboxId: activeSandbox,
        kiloToken: runtimeAuthorizedKiloToken(),
      }),
      message: promptPayload(messageId()),
      sandboxSelection: { provider: 'cloudflare' },
      runtimeAuthorizationSeal: activeSeal,
    });
    expect(admission.success).toBe(true);
    await expect(activeStub.getRuntimeAuthorizationStatus()).resolves.toMatchObject({
      state: 'active',
    });

    const stored = await runInDurableObject(activeStub, (_instance, state) =>
      state.storage.get<Record<string, unknown>>('runtime_authorization')
    );
    expect(stored).toBeDefined();
    await runInDurableObject(activeStub, (_instance, state) =>
      state.storage.put('runtime_authorization', {
        ...stored,
        issuedAt: new Date(Date.now() - 7_200_000).toISOString(),
        delegationExpiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      })
    );
    await expect(activeStub.getRuntimeAuthorizationStatus()).resolves.toMatchObject({
      state: 'expired',
    });
  });

  it('rejects invalid modern proxy configuration without installing session or authorization state', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const stub = sessions.getByName(sessionId);
    await installPeer(stub, new FakeSandboxPeer());
    await runInDurableObject(stub, instance => {
      instance.env.WORKER_URL = undefined;
    });
    const result = await stub.registerSessionFromMetadata({
      metadata: metadata({
        sessionId,
        sandboxId,
        kiloSessionId: kiloSessionId(),
        kiloToken: runtimeAuthorizedKiloToken(),
      }),
      sandboxSelection: { provider: 'cloudflare' },
    });
    expect(result).toMatchObject({
      success: false,
      code: 'BAD_REQUEST',
      error: 'Runtime credential proxy configuration is unavailable',
    });
    expect(await stub.getMetadata()).toBeNull();
    expect(await stub.getSession()).toEqual({ type: 'session-not-found' });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('session_metadata')).toBeUndefined();
      expect(await state.storage.get('control_plane_session')).toBeUndefined();
      expect(await state.storage.get('runtime_authorization')).toBeUndefined();
    });
  });

  it('deletes the session, releases its route and wipes its storage idempotently', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const stub = sessions.getByName(sessionId);
    const peer = new FakeSandboxPeer();
    const releaseCalls: string[] = [];
    peer.release = async payload => {
      releaseCalls.push(payload.sessionId);
    };
    await installPeer(stub, peer);
    await stub.createSessionWithInitialAdmission({
      metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
      message: promptPayload(messageId()),
      sandboxSelection: { provider: 'cloudflare' },
    });

    await expect(stub.getSession()).resolves.toMatchObject({ type: 'found' });

    await stub.deleteSession();

    expect(releaseCalls).toEqual([sessionId]);
    await expect(stub.getSession()).resolves.toEqual({ type: 'session-not-found' });
    await expect(stub.getMetadata()).resolves.toBeNull();
    await expect(
      runInDurableObject(stub, (_instance, state) => state.storage.get('control_plane_session'))
    ).resolves.toBeUndefined();

    // A second delete is a no-op and does not release again.
    await stub.deleteSession();
    expect(releaseCalls).toEqual([sessionId]);
  });

  it('returns the worktree runtime location and rejects a foreign worktree', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const worktree = worktreeId();
    const kilo = kiloSessionId();
    const workspacePath = `/workspace/worktrees/${worktree}`;
    const stub = await registerSession({
      sessionId,
      sandboxId,
      kiloSessionId: kilo,
      worktreeId: worktree,
      workspacePath,
    });

    await expect(
      stub.beginWorktreeDeletion({
        worktreeId: worktree,
        kiloSessionId: kilo,
        ownerId: USER_ID,
        organizationId: ORG_ID,
      })
    ).resolves.toEqual({ location: { sandboxId, provider: 'cloudflare' }, children: [] });

    await expect(
      runInDurableObject(stub, instance =>
        instance.beginWorktreeDeletion({
          worktreeId: worktreeId(),
          kiloSessionId: kilo,
          ownerId: USER_ID,
          organizationId: ORG_ID,
        })
      )
    ).rejects.toThrow('Worktree identity conflict');

    await expect(
      sessions.getByName(newSessionId()).beginWorktreeDeletion({
        worktreeId: worktree,
        kiloSessionId: kilo,
        ownerId: USER_ID,
      })
    ).resolves.toEqual({ location: null, children: [] });
  });

  it('reads child Kilo sessions from the stored event log', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const worktree = worktreeId();
    const ownKilo = kiloSessionId();
    const firstChild = kiloSessionId();
    const secondChild = kiloSessionId();
    const workspacePath = `/workspace/worktrees/${worktree}`;
    const stub = await registerSession({
      sessionId,
      sandboxId,
      kiloSessionId: ownKilo,
      worktreeId: worktree,
      workspacePath,
    });

    const created = (id: string, parentID: string, directory: string) =>
      JSON.stringify({
        type: 'session.created',
        event: 'session.created',
        properties: { info: { id, parentID, directory } },
      });

    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db.insert(events).values([
        {
          execution_id: '',
          session_id: sessionId,
          stream_event_type: 'kilocode',
          payload: created(firstChild, ownKilo, workspacePath),
          timestamp: 1,
        },
        // A repeat update of the same child must not duplicate the lineage.
        {
          execution_id: '',
          session_id: sessionId,
          stream_event_type: 'kilocode',
          payload: created(firstChild, ownKilo, workspacePath),
          timestamp: 2,
        },
        // A child in another directory is not part of this worktree.
        {
          execution_id: '',
          session_id: sessionId,
          stream_event_type: 'kilocode',
          payload: created(secondChild, ownKilo, '/workspace/other'),
          timestamp: 3,
        },
        // The session's own Kilo session is excluded.
        {
          execution_id: '',
          session_id: sessionId,
          stream_event_type: 'kilocode',
          payload: created(ownKilo, firstChild, workspacePath),
          timestamp: 4,
        },
      ]);
    });

    const begin = await stub.beginWorktreeDeletion({
      worktreeId: worktree,
      kiloSessionId: ownKilo,
      ownerId: USER_ID,
      organizationId: ORG_ID,
    });
    expect(begin.children).toEqual([{ sessionId: firstChild, parentSessionId: ownKilo }]);
  });

  it('finishes worktree deletion by wiping the session storage', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const worktree = worktreeId();
    const stub = await registerSession({
      sessionId,
      sandboxId,
      kiloSessionId: kiloSessionId(),
      worktreeId: worktree,
      workspacePath: `/workspace/worktrees/${worktree}`,
    });

    await expect(stub.getSession()).resolves.toMatchObject({ type: 'found' });
    await stub.finishWorktreeDeletion(worktree);

    await expect(stub.getSession()).resolves.toEqual({ type: 'session-not-found' });
    await expect(stub.getMetadata()).resolves.toBeNull();
    // A repeated finish is a no-op.
    await expect(stub.finishWorktreeDeletion(worktree)).resolves.toBeUndefined();
  });

  it('purges on finish regardless of the informational worktree id and is idempotent', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const worktree = worktreeId();
    const stub = await registerSession({
      sessionId,
      sandboxId,
      kiloSessionId: kiloSessionId(),
      worktreeId: worktree,
      workspacePath: `/workspace/worktrees/${worktree}`,
    });

    // A mismatched id is informational: begin validated identity, and the
    // Sandbox DO already confirmed cleanup before finish runs.
    await expect(
      runInDurableObject(stub, instance => instance.finishWorktreeDeletion(worktreeId()))
    ).resolves.toBeUndefined();
    await expect(stub.getSession()).resolves.toEqual({ type: 'session-not-found' });
  });

  it('settles open messages as interrupted and reports them before deleting', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const stub = sessions.getByName(sessionId);
    const peer = new FakeSandboxPeer();
    peer.prepareView = peer.view('ready');
    await installPeer(stub, peer);
    const captured = await installCapturedQueues(stub);

    const accepted = messageId();
    await stub.createSessionWithInitialAdmission({
      metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
      message: promptPayload(accepted),
      sandboxSelection: { provider: 'cloudflare' },
    });
    // A second message whose delivery is not ready stays queued beside it.
    peer.deliverResult = 'not_ready';
    const queued = messageId();
    await stub.send(promptPayload(queued));

    const snapshot = await stub.getSession();
    if (snapshot.type !== 'found') throw new Error('expected a found session');
    const states = new Map(snapshot.messages.map(message => [message.messageId, message.state]));
    expect(states.get(accepted)).toBe('accepted');
    expect(states.get(queued)).toBe('queued');

    await stub.deleteSession();

    // Every open message reached a terminal report/callback before the wipe.
    expect(captured.reports.map(report => report.run.messageId).sort()).toEqual(
      [accepted, queued].sort()
    );
    expect(captured.reports.every(report => report.run.status === 'interrupted')).toBe(true);
    expect(captured.callbacks[0]?.payload.status).toBe('interrupted');

    await expect(stub.getSession()).resolves.toEqual({ type: 'session-not-found' });
    const rows = await runInDurableObject(stub, (_instance, state) =>
      drizzle(state.storage, { logger: false }).select().from(controlPlaneMessages).all()
    );
    expect(rows).toEqual([]);
  });

  it('leaves the session intact when release fails, then completes on retry', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const stub = sessions.getByName(sessionId);
    const peer = new FakeSandboxPeer();
    let releaseCalls = 0;
    peer.release = async () => {
      releaseCalls += 1;
      throw new Error('release unavailable');
    };
    await installPeer(stub, peer);
    await stub.registerSessionFromMetadata({
      metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
      sandboxSelection: { provider: 'cloudflare' },
    });

    // A permanent release failure aborts before the wipe, so deletion retries.
    await expect(runInDurableObject(stub, instance => instance.deleteSession())).rejects.toThrow();
    expect(releaseCalls).toBe(1);
    await expect(stub.getSession()).resolves.toMatchObject({ type: 'found' });
    await expect(stub.getMetadata()).resolves.not.toBeNull();

    peer.release = async () => {};
    await stub.deleteSession();
    await expect(stub.getSession()).resolves.toEqual({ type: 'session-not-found' });
  });

  it('does not persist a send that is queued behind a delete', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const stub = sessions.getByName(sessionId);
    await installPeer(stub, new FakeSandboxPeer());
    await stub.registerSessionFromMetadata({
      metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
      sandboxSelection: { provider: 'cloudflare' },
    });

    const racing = messageId();
    await runInDurableObject(stub, async instance => {
      // delete is enqueued first; the send that follows runs after the wipe.
      const deleted = instance.deleteSession();
      const sent = instance.send(promptPayload(racing));
      await deleted;
      await sent;
    });

    await expect(stub.getSession()).resolves.toEqual({ type: 'session-not-found' });
    const rows = await runInDurableObject(stub, (_instance, state) =>
      drizzle(state.storage, { logger: false }).select().from(controlPlaneMessages).all()
    );
    expect(rows).toEqual([]);
  });

  it('suppresses worktree capture while deleting', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const stub = await registerSession({ sessionId, sandboxId, kiloSessionId: kiloSessionId() });

    let suppressCalls = 0;
    await runInDurableObject(stub, instance => {
      const wrapper = (instance as unknown as { worktreeChanges: { suppress: () => void } })
        .worktreeChanges;
      const original = wrapper.suppress.bind(wrapper);
      wrapper.suppress = () => {
        suppressCalls += 1;
        original();
      };
    });

    await stub.deleteSession();
    expect(suppressCalls).toBe(1);
  });
});
