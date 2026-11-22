import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { publicCloudAgentDirectory } from '../../src/kilo-facade/public-sdk-projection.js';
import { createMessageId } from '../../src/session/message-id.js';
import {
  clearTestSessionIngestState,
  writeTestSessionIngestState,
} from './helpers/session-ingest-double.js';

type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;

// `cloudflare:test`'s `env` is typed as the test worker's `TestEnv`, which omits
// the session namespace; the binding exists in `wrangler.test.jsonc`.
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_answer_balance';
const ORG_ID = '22222222-3333-4444-8555-666666666666';
const SECRET = env.NEXTAUTH_SECRET as string;

const kiloSessionId = `ses_${'answerba1anceadm1ss10n'.padEnd(26, '0')}`;
const cloudAgentSessionId = 'workspace_30000000-0000-4000-8000-000000000002';

/**
 * The settled answer becomes a new Cloud Agent turn, so the facade reads the
 * payer balance and validates the model against the Cloud backend before it
 * admits it. The run replaces those two outbound responses; routing,
 * authorization, the Durable Objects and the durable queue stay real.
 */
type BalancePage = { balance: number; isDepleted: boolean };

type FetchScope = {
  fetch: typeof fetch;
  __answerBalanceOriginalFetch?: typeof fetch;
  __answerBalanceRequests?: string[];
};

const DEPLETED_PAGE: BalancePage = { balance: 0, isDepleted: true };
const FUNDED_PAGE: BalancePage = { balance: 20, isDepleted: false };

function sessionStub() {
  return sessions.getByName(sessionDoName(USER_ID, cloudAgentSessionId));
}

function facadeStub() {
  return env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(USER_ID));
}

type CatalogDecision = { valid: true } | { valid: false; reason: 'unavailable' };

async function installBackendResponder(
  page: BalancePage,
  validation: CatalogDecision = { valid: true }
): Promise<{ release: () => Promise<void>; requests: () => Promise<string[]> }> {
  // The balance and catalogue preflight runs in the facade DO, on the caller's
  // identity, exactly like the prompt route.
  const facade = facadeStub();
  await runInDurableObject(facade, () => {
    const scope = globalThis as unknown as FetchScope;
    scope.__answerBalanceOriginalFetch ??= scope.fetch;
    scope.__answerBalanceRequests = [];
    scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      scope.__answerBalanceRequests?.push(url.pathname);
      if (url.pathname.endsWith('/balance')) return Response.json(page);
      if (url.pathname.endsWith('/models/validate')) return Response.json(validation);
      throw new Error(`unexpected outbound fetch ${url.origin}${url.pathname}`);
    };
  });
  return {
    release: async () => {
      await runInDurableObject(facade, () => {
        const scope = globalThis as unknown as FetchScope;
        if (scope.__answerBalanceOriginalFetch) {
          scope.fetch = scope.__answerBalanceOriginalFetch;
          delete scope.__answerBalanceOriginalFetch;
        }
        delete scope.__answerBalanceRequests;
      });
    },
    requests: () =>
      runInDurableObject(facade, () => {
        const scope = globalThis as unknown as FetchScope;
        return [...(scope.__answerBalanceRequests ?? [])];
      }),
  };
}

function metadata(input: { sandboxId: string; kiloToken: string }) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: cloudAgentSessionId,
      userId: USER_ID,
      orgId: ORG_ID,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId, kilocodeToken: input.kiloToken },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'git', url: 'https://github.com/acme/widgets.git', platform: 'github' },
    workspace: {
      branchName: 'kilo/answer-admission',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare-containers',
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

/**
 * A live runtime authorization for the session, so registration and admission
 * are not blocked, and the modern runtime token the session stores: the catalogue
 * preflight forwards it as a bearer and attests it, exactly as in production.
 */
async function sealedAuthorization(): Promise<{ seal: string; token: string }> {
  const now = Date.now();
  const authorizationId = crypto.randomUUID();
  const seal = await sealRuntimeAuthorization(
    {
      version: 1,
      id: authorizationId,
      resourceKind: 'cloud-agent-next',
      resourceId: cloudAgentSessionId,
      userId: USER_ID,
      authorizationUserId: USER_ID,
      organizationId: ORG_ID,
      issuedAt: new Date(now).toISOString(),
      delegationExpiresAt: new Date(now + 24 * 60 * 60_000).toISOString(),
      state: 'active',
      bindings: {
        userPepperDigest: 'null',
        authorizationPepperDigest: 'null',
        userMembershipId: 'membership_1',
        authorizationUserMembershipId: 'membership_1',
      },
      source: { admissionSource: 'user' },
    },
    SECRET
  );
  const token = (
    await signModernKiloToken({
      userId: USER_ID,
      pepper: null,
      secret: SECRET,
      expiresInSeconds: 3600,
      audience: ['kilo-api', 'kilo-gateway', 'session-ingest'],
      tokenPurpose: 'delegated-workload',
      credentialExchange: false,
      now: new Date(now),
      extra: {
        organizationId: ORG_ID,
        runtimeAuthorization: {
          id: authorizationId,
          resourceKind: 'cloud-agent-next',
          resourceId: cloudAgentSessionId,
        },
      },
    })
  ).token;
  return { seal, token };
}

/**
 * A registered session with no compute, so an admitted answer stays queued and
 * the asking turn stays settled for every attempt below.
 */
async function registerColdSession(): Promise<DurableObjectStub<SandboxSessionV2>> {
  const authorization = await sealedAuthorization();
  const stub = sessionStub();
  const created = await stub.registerSessionFromMetadata({
    metadata: metadata({
      sandboxId: await generateSandboxId(cloudAgentSessionId),
      kiloToken: authorization.token,
    }),
    sandboxSelection: { provider: 'cloudflare-containers' },
    runtimeAuthorizationSeal: authorization.seal,
  });
  if (created.success !== true) {
    throw new Error(`session registration failed: ${JSON.stringify(created)}`);
  }
  return stub;
}

/**
 * Queue one prompt that no route ever delivers, so the asking turn is settled,
 * then record the question that answer continues from.
 */
async function askQuestion(stub: DurableObjectStub<SandboxSessionV2>): Promise<void> {
  await stub.send({
    messageId: createMessageId(),
    turn: { type: 'prompt', prompt: 'start' },
    agent: { mode: 'code', model: 'test/model' },
  });
  await stub.onEvents({
    events: [{ type: 'question.asked', properties: { id: 'q_1' } }],
  });
}

function seedFacadeRoot(): Promise<void> {
  return runInDurableObject(
    env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(USER_ID)),
    async (_instance, state) => {
      await writeTestSessionIngestState(state.storage, {
        roots: [{ kiloSessionId, cloudAgentSessionId, title: 'answer admission' }],
      });
    }
  );
}

function clearFacadeRoots(): Promise<void> {
  return runInDurableObject(
    env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(USER_ID)),
    async (_instance, state) => {
      await clearTestSessionIngestState(state.storage);
    }
  );
}

function answerUrl(): string {
  return `http://worker.test/kilo-test/kilo/question/q_1/reply?userId=${USER_ID}&directory=${encodeURIComponent(
    publicCloudAgentDirectory(kiloSessionId)
  )}`;
}

function postAnswer(): Promise<Response> {
  return SELF.fetch(answerUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: [['Blue']] }),
  });
}

async function messageCount(stub: DurableObjectStub<SandboxSessionV2>): Promise<number> {
  const snapshot = await stub.getSession();
  return snapshot.type === 'found' ? snapshot.messages.length : -1;
}

afterEach(async () => {
  await clearFacadeRoots().catch(() => undefined);
  await reset();
});

describe('hosted facade settled-answer admission', { timeout: 30_000 }, () => {
  it('admits a funded answer as a new turn and clears the question', async () => {
    const stub = await registerColdSession();
    await askQuestion(stub);
    const before = await messageCount(stub);
    await seedFacadeRoot();
    const backend = await installBackendResponder(FUNDED_PAGE);
    try {
      const response = await postAnswer();
      expect(response.status).toBe(200);

      expect(await messageCount(stub)).toBe(before + 1);
      await expect(stub.getPendingInteractions()).resolves.toEqual({
        questions: [],
        permissions: [],
      });
      // Balance first, then the model catalogue — the prompt route's order.
      const issued = await backend.requests();
      expect(issued.filter(path => path.endsWith('/balance'))).toHaveLength(1);
    } finally {
      await backend.release();
    }
  });

  it('refuses a depleted payer and leaves the question answerable', async () => {
    const stub = await registerColdSession();
    await askQuestion(stub);
    const before = await messageCount(stub);
    await seedFacadeRoot();
    const backend = await installBackendResponder(DEPLETED_PAGE);
    try {
      const response = await postAnswer();
      expect(response.status).toBe(402);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_BALANCE_VALIDATION_FAILED',
      });

      // No new turn was queued and the question is still pending, so the user can
      // add credit and answer it again.
      expect(await messageCount(stub)).toBe(before);
      await expect(stub.getPendingInteractions()).resolves.toMatchObject({
        questions: [{ id: 'q_1' }],
      });
      const issued = await backend.requests();
      expect(issued.filter(path => path.endsWith('/balance'))).toHaveLength(1);
      expect(issued.some(path => path.endsWith('/models/validate'))).toBe(false);
    } finally {
      await backend.release();
    }
  });

  it('refuses an unavailable model before it queues anything', async () => {
    const stub = await registerColdSession();
    await askQuestion(stub);
    const before = await messageCount(stub);
    await seedFacadeRoot();
    const backend = await installBackendResponder(FUNDED_PAGE, {
      valid: false,
      reason: 'unavailable',
    });
    try {
      const response = await postAnswer();
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_PROMPT_ADMISSION_REJECTED',
      });
      expect(await messageCount(stub)).toBe(before);
      await expect(stub.getPendingInteractions()).resolves.toMatchObject({
        questions: [{ id: 'q_1' }],
      });
    } finally {
      await backend.release();
    }
  });

  it('refuses an answer the session does not wait on without reading the balance', async () => {
    const stub = await registerColdSession();
    await seedFacadeRoot();
    const backend = await installBackendResponder(FUNDED_PAGE);
    try {
      const response = await postAnswer();
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_INTERACTION_UNAVAILABLE',
      });
      expect(await backend.requests()).toEqual([]);
      expect(await messageCount(stub)).toBe(0);
    } finally {
      await backend.release();
    }
  });
});
