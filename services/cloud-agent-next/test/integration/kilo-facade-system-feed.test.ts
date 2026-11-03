import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../src/session/queries/index.js';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import { createMessageId } from '../../src/session/message-id.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlanePromptPayload,
} from '../../src/shared/control-plane-protocol.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  ProviderLaunchResult,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import {
  createFakeCredentialBroker,
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { installFakeRuntimeProxyPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { createSseDataReader, readSseUntil } from './helpers/sse-reader.js';
import {
  clearTestSessionIngestState,
  writeTestSessionIngestState,
} from './helpers/session-ingest-double.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;

const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_system_feed';
const OTHER_USER_ID = 'user_system_feed_other';
const ORG_ID = 'org_system_feed';
// `containedKiloSessionIdSchema` requires exactly 26 alphanumerics after the prefix.
const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
const cloudAgentSessionId = `workspace_${'30000000-0000-4000-8000-000000000003'}`;

function metadata(sandboxId: string) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: cloudAgentSessionId,
      userId: USER_ID,
      orgId: ORG_ID,
      createdOnPlatform: 'desktop',
    },
    auth: { kiloSessionId, kilocodeToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'git', url: 'https://github.com/acme/widgets.git', platform: 'github' },
    workspace: { branchName: 'kilo/system-feed', sandboxId, sandboxProvider: 'cloudflare' },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function createCountingProvider(): {
  adapter: ProviderAdapter;
  createCalls: () => number;
  launchEnvs: Record<string, string>[];
} {
  const provider = {
    createCount: 0,
    launchEnvs: [] as Record<string, string>[],
  };
  const adapter: ProviderAdapter = {
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      provider.createCount += 1;
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(
      _ref: string,
      startup: { env: Record<string, string> }
    ): Promise<ProviderLaunchResult> {
      provider.launchEnvs.push({ ...startup.env });
      return { startSource: 'image' as const };
    },
    async observe(ref: string | null) {
      return { status: 'active' as const, ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(): Promise<StopResult> {
      return 'terminal';
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return { adapter, createCalls: () => provider.createCount, launchEnvs: provider.launchEnvs };
}

async function installSandbox(sandboxId: string, provider: ProviderAdapter): Promise<void> {
  const sandboxStub = sandboxes.getByName(sandboxId);
  const broker = createFakeCredentialBroker();
  await runInDurableObject(sandboxStub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(
      (instance as unknown as { env: Record<string, unknown> }).env,
      broker,
      {
        SandboxSmallContainment: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
        WORKER_URL: 'https://control.test',
        KILOCODE_BACKEND_BASE_URL: 'https://control.test',
        KILO_OPENROUTER_BASE: 'https://control.test',
        KILO_SESSION_INGEST_URL: 'https://control.test',
      }
    );
    Object.assign(instance, { createProviderAdapter: () => provider, provider });
    installFakeRuntimeProxyPeer(instance);
  });
}

/** Answers `session.prepare` with `session.ready`, the one wrapper behavior the route needs. */
function startWrapperPump(wrapper: FakeWrapper): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const frame = await wrapper.next(250);
      if (frame === null) continue;
      try {
        if (frame.type === 'session.prepare') {
          wrapper.send({ type: 'session.ready', sessionId: frame.spec.sessionId });
        }
      } catch {
        return;
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

type ActiveSession = {
  stub: DurableObjectStub<SandboxSessionV2>;
  wrapper: FakeWrapper;
  stopPump: () => void;
  createCalls: () => number;
};

async function startReadySession(): Promise<ActiveSession> {
  const sandboxId = await generateSandboxId(
    undefined,
    ORG_ID,
    USER_ID,
    cloudAgentSessionId,
    undefined
  );
  const provider = createCountingProvider();
  await installSandbox(sandboxId, provider.adapter);

  const stub = sessions.getByName(sessionDoName(USER_ID, cloudAgentSessionId));
  const message: ControlPlanePromptPayload = {
    messageId: createMessageId(),
    turn: { type: 'prompt', prompt: 'system feed fixture' },
    agent: { mode: 'code', model: 'test/model' },
  };
  await stub.createSessionWithInitialAdmission({
    metadata: metadata(sandboxId),
    message,
    sandboxSelection: { provider: 'cloudflare' },
  });

  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const launchEnv = provider.launchEnvs[0];
  if (!launchEnv?.SANDBOX_CONTROL_CREDENTIAL || !launchEnv.CONTROL_PLANE_ALLOCATION_ID) {
    throw new Error('launch environment is missing identity');
  }
  const wrapper = await FakeWrapper.connect({
    sandboxId,
    credential: launchEnv.SANDBOX_CONTROL_CREDENTIAL,
  });
  const welcome = await wrapper.hello({
    wrapperId: 'wr_system_feed',
    allocationId: launchEnv.CONTROL_PLANE_ALLOCATION_ID,
  });
  expect(welcome).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
  const stopPump = startWrapperPump(wrapper);

  await waitFor(async () => {
    const result = await stub.getMessageResult(message.messageId);
    expect(result.type === 'found' ? result.result.status : null).toBe('running');
  });

  return { stub, wrapper, stopPump, createCalls: provider.createCalls };
}

function isFrame(value: unknown, type: string): value is { type: string; properties: unknown } {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === type;
}

async function seedFacadeRoots(rootKiloSessionId: string, rootSessionId: string): Promise<void> {
  const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(USER_ID));
  await runInDurableObject(facade, async (_instance, state) => {
    await writeTestSessionIngestState(state.storage, {
      roots: [{ kiloSessionId: rootKiloSessionId, cloudAgentSessionId: rootSessionId }],
    });
  });
}

async function clearFacadeRoots(): Promise<void> {
  const facade = env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(USER_ID));
  await runInDurableObject(facade, async (_instance, state) => {
    await clearTestSessionIngestState(state.storage);
  });
}

function openSystemFeed(userId: string, sessionId: string): Promise<Response> {
  const directory = encodeURIComponent(`/cloud-agent/sessions/${sessionId}`);
  return SELF.fetch(
    `http://worker.test/kilo-test/kilo/cloud-agent/event?userId=${userId}&directory=${directory}`
  );
}

afterEach(async () => {
  await clearFacadeRoots().catch(() => undefined);
  await reset();
});

describe('hosted system feed', { timeout: 30_000 }, () => {
  it('bridges preparation, cloud status, and the sandbox snapshot without waking compute', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots(kiloSessionId, cloudAgentSessionId);
      const createCallsBefore = session.createCalls();

      const response = await openSystemFeed(USER_ID, kiloSessionId);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = createSseDataReader(response);
      try {
        const { observed } = await readSseUntil(reader, frame =>
          isFrame(frame, 'cloud.sandbox.status')
        );
        expect(observed.some(frame => isFrame(frame, 'preparing'))).toBe(true);
        expect(observed.some(frame => isFrame(frame, 'cloud.status'))).toBe(true);
        const snapshot = observed.find(frame => isFrame(frame, 'cloud.sandbox.status')) as {
          properties: { sessionID: string; sandbox: { status: string } };
        };
        expect(snapshot.properties.sessionID).toBe(kiloSessionId);
      } finally {
        await reader.cancel();
      }

      expect(session.createCalls()).toBe(createCallsBefore);
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  it('delivers a replay larger than the transport queue without waking compute', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots(kiloSessionId, cloudAgentSessionId);
      await runInDurableObject(session.stub, async (_instance, state) => {
        const queries = createEventQueries(drizzle(state.storage), state.storage.sql);
        for (let index = 0; index < 128; index++) {
          queries.insert({
            executionId: `history-${index}`,
            sessionId: cloudAgentSessionId,
            streamEventType: 'preparing',
            timestamp: Date.now(),
            payload: JSON.stringify({ step: 'cloning', message: `history-${index}` }),
          });
        }
      });
      const before = session.createCalls();
      const reader = createSseDataReader(await openSystemFeed(USER_ID, kiloSessionId));
      try {
        const { observed } = await readSseUntil(
          reader,
          frame => {
            if (!isFrame(frame, 'preparing')) return false;
            return (
              (frame.properties as { preparation?: { message?: string } }).preparation?.message ===
              'history-127'
            );
          },
          256
        );
        expect(observed.filter(frame => isFrame(frame, 'preparing')).length).toBeGreaterThanOrEqual(
          128
        );
      } finally {
        await reader.cancel();
      }
      expect(session.createCalls()).toBe(before);
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  it('keeps replaying preparation after the runtime stops without waking compute', async () => {
    const session = await startReadySession();
    try {
      await seedFacadeRoots(kiloSessionId, cloudAgentSessionId);
      const snapshot = await session.stub.getSession();
      if (snapshot.type !== 'found' || !snapshot.route.attemptId) {
        throw new Error('expected a prepared route attempt');
      }
      await session.stub.onRoute({
        state: 'lost',
        attemptId: snapshot.route.attemptId,
        reason: 'sandbox_stopped',
      });
      session.stopPump();
      session.wrapper.close();
      const createCallsBefore = session.createCalls();

      const response = await openSystemFeed(USER_ID, kiloSessionId);
      expect(response.status).toBe(200);
      const reader = createSseDataReader(response);
      try {
        const { observed } = await readSseUntil(reader, frame => isFrame(frame, 'preparing'));
        expect(observed.some(frame => isFrame(frame, 'preparing'))).toBe(true);
      } finally {
        await reader.cancel();
      }

      expect(session.createCalls()).toBe(createCallsBefore);
    } finally {
      session.stopPump();
      session.wrapper.close();
    }
  });

  it('hides a foreign system feed selector and rejects a wrong selector', async () => {
    await seedFacadeRoots(kiloSessionId, cloudAgentSessionId);

    const foreign = await openSystemFeed(OTHER_USER_ID, kiloSessionId);
    expect(foreign.status).toBe(404);

    const malformed = await SELF.fetch(
      'http://worker.test/kilo-test/kilo/cloud-agent/event?userId=user_system_feed&directory=%2Fcloud-agent%2Fsessions%2Fbad-id'
    );
    expect(malformed.status).toBe(404);

    const wrongSelector = await SELF.fetch(
      'http://worker.test/kilo-test/kilo/cloud-agent/event?userId=user_system_feed&workspace=private'
    );
    expect(wrongSelector.status).toBe(400);
  });
});
