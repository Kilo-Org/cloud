import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import {
  clearTestSessionIngestState,
  writeTestSessionIngestState,
} from './helpers/session-ingest-double.js';

type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;

const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_command_balance';
const ORG_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = env.NEXTAUTH_SECRET as string;

const userId = USER_ID;
const kiloSessionId = `ses_${'c0mmandba1ancegate'.padEnd(26, '0')}`;
const cloudAgentSessionId = 'workspace_20000000-0000-4000-8000-000000000001';

/**
 * The facade reads the payer's balance from the Cloud backend, so the run
 * replaces that one outbound response. Routing, authorization, the Durable
 * Objects and the durable queue stay real.
 */
type BalancePage = { balance: number; isDepleted: boolean };

type FetchScope = {
  fetch: typeof fetch;
  __commandBalanceOriginalFetch?: typeof fetch;
};

const DEPLETED_PAGE: BalancePage = { balance: 0, isDepleted: true };
const FUNDED_PAGE: BalancePage = { balance: 20, isDepleted: false };

function facadeStub() {
  return env.USER_KILO_FACADE.get(env.USER_KILO_FACADE.idFromName(userId));
}

async function installBalanceResponder(page: BalancePage): Promise<() => Promise<void>> {
  const facade = facadeStub();
  await runInDurableObject(facade, () => {
    const scope = globalThis as unknown as FetchScope;
    scope.__commandBalanceOriginalFetch ??= scope.fetch;
    scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/balance')) return Response.json(page);
      throw new Error(`unexpected outbound fetch ${url.origin}${url.pathname}`);
    };
  });
  return async () => {
    await runInDurableObject(facade, () => {
      const scope = globalThis as unknown as FetchScope;
      if (scope.__commandBalanceOriginalFetch) {
        scope.fetch = scope.__commandBalanceOriginalFetch;
        delete scope.__commandBalanceOriginalFetch;
      }
    });
  };
}

function metadata(input: { sandboxId: string; kiloToken: string }) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: cloudAgentSessionId,
      userId: USER_ID,
      orgId: ORG_ID,
      createdOnPlatform: 'desktop',
    },
    auth: { kiloSessionId, kilocodeToken: input.kiloToken },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'git', url: 'https://github.com/acme/widgets.git', platform: 'github' },
    workspace: {
      branchName: 'kilo/native-command',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare-containers',
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

/** A live runtime authorization for the session, so admission is not blocked. */
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
  const token = jwt.sign(
    { runtimeAuthorization: { id: authorizationId }, exp: Math.floor(now / 1000) + 3600 },
    SECRET
  );
  return { seal, token };
}

/** A registered session that has not requested compute. */
async function registerColdSession(): Promise<DurableObjectStub<SandboxSessionV2>> {
  const authorization = await sealedAuthorization();
  const stub = sessions.getByName(sessionDoName(USER_ID, cloudAgentSessionId));
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

function seedFacadeRoot(): Promise<void> {
  return runInDurableObject(facadeStub(), async (_instance, state) => {
    await writeTestSessionIngestState(state.storage, {
      roots: [{ kiloSessionId, cloudAgentSessionId, title: 'command balance' }],
    });
  });
}

function clearFacadeRoots(): Promise<void> {
  return runInDurableObject(facadeStub(), async (_instance, state) => {
    await clearTestSessionIngestState(state.storage);
  });
}

function facadeSessionUrl(suffix: string): string {
  return `http://worker.test/kilo-test/kilo/session/${kiloSessionId}${suffix}?userId=${userId}`;
}

function postFacadeMutation(suffix: string, body: unknown, headers = {}) {
  return SELF.fetch(facadeSessionUrl(suffix), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await clearFacadeRoots().catch(() => undefined);
  await reset();
});

describe('hosted facade command balance gate', { timeout: 30_000 }, () => {
  it('answers a command turn with the payer balance failure', async () => {
    const stub = await registerColdSession();
    await seedFacadeRoot();
    const restore = await installBalanceResponder(DEPLETED_PAGE);
    try {
      const prompt = await postFacadeMutation('/prompt_async', {
        parts: [{ type: 'text', text: 'hello' }],
      });
      expect(prompt.status).toBe(402);
      await expect(prompt.json()).resolves.toMatchObject({
        error: 'KILO_BALANCE_VALIDATION_FAILED',
      });

      const messageId = 'msg_command_balance_denied';
      const command = await postFacadeMutation('/command', {
        messageID: messageId,
        command: 'compact',
      });
      expect(command.status).toBe(402);
      await expect(command.json()).resolves.toMatchObject({
        error: 'KILO_BALANCE_VALIDATION_FAILED',
      });
      await expect(stub.getMessageResult(messageId)).resolves.toEqual({
        type: 'message-not-found',
      });
    } finally {
      await restore();
    }
  });

  it('admits a command turn for a payer with usable balance', async () => {
    await registerColdSession();
    await seedFacadeRoot();
    const restore = await installBalanceResponder(FUNDED_PAGE);
    try {
      const prompt = await postFacadeMutation('/prompt_async', {
        parts: [{ type: 'text', text: 'hello' }],
      });
      const command = await postFacadeMutation('/command', { command: 'compact' });
      // Both mutations reach the same downstream preflight for a session
      // without live compute, so each answers with its own route result.
      expect(prompt.status).toBe(command.status);
      const body = await command.json();
      expect(body).not.toMatchObject({ error: 'KILO_BALANCE_VALIDATION_FAILED' });
    } finally {
      await restore();
    }
  });

  it('answers a request that carries the bypass header with its documented refusal', async () => {
    await seedFacadeRoot();
    const response = await postFacadeMutation(
      '/command',
      { command: 'compact' },
      { 'x-skip-balance-check': '1' }
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_BALANCE_BYPASS_UNSUPPORTED',
    });
  });
});
