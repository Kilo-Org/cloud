import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { DurableAdmissionAck } from '../../src/execution/types.js';
import type { KiloFacadeRequestDeps } from '../../src/kilo-facade/user-kilo-facade.js';
import { publicCloudAgentDirectory } from '../../src/kilo-facade/public-sdk-projection.js';
import type { Env } from '../../src/types.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// The facade module imports `cloudflare:workers`, which Node cannot resolve, so
// the import waits until the stub above is hoisted in place of the real module.
const { handleKiloFacadeRequest } = await import('../../src/kilo-facade/user-kilo-facade.js');

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set POSTGRES_URL to the isolated local test database');
const client = createDrizzleClient({ connectionString, ssl: false });

const callerId = `oauth/payer-scope-${randomUUID()}`;
const organizationId = randomUUID();
const organizationKiloSessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
const organizationCloudAgentSessionId = `workspace_${randomUUID()}`;
const personalKiloSessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
const personalCloudAgentSessionId = `workspace_${randomUUID()}`;

// This suite drives the request path after authentication, so any signed token
// stands in for the caller's bearer.
const authToken = jwt.sign({ sub: callerId }, 'payer-scope-test-secret');

const QUEUED_ADMISSION: DurableAdmissionAck = {
  success: true,
  outcome: 'queued',
  compatibilityDelivery: 'queued',
  messageId: 'msg_018f1e2d3c4bPayerScopeAbCdEf',
};

type RecordedRequest = { url: string; headers: Record<string, string> };

const originalFetch = globalThis.fetch;
let recorded: RecordedRequest[] = [];
let balanceAnswer: { balance: number; isDepleted: boolean } = { balance: 12, isDepleted: false };

function sessionMetadata(cloudAgentSessionId: string, sessionOrganizationId: string | null) {
  return {
    metadataSchemaVersion: 2,
    identity: {
      sessionId: cloudAgentSessionId,
      userId: callerId,
      ...(sessionOrganizationId === null ? {} : { orgId: sessionOrganizationId }),
    },
    auth: {},
    agent: { model: 'kilo/anthropic/claude-sonnet-4' },
    lifecycle: { version: 1, timestamp: 1 },
  };
}

const stubs = new Map(
  [
    [organizationCloudAgentSessionId, organizationId],
    [personalCloudAgentSessionId, null],
  ].map(([sessionId, sessionOrganizationId]) => [
    sessionId as string,
    {
      getMetadata: async () => sessionMetadata(sessionId as string, sessionOrganizationId),
    },
  ])
);

function envStub(): Env {
  return {
    HYPERDRIVE: { connectionString },
    SANDBOX_SESSION: {
      idFromName: (name: string) => name,
      get: (name: string) => stubs.get(name.split(':').pop() ?? ''),
    },
    SESSION_INGEST: {
      resolveCloudAgentRootSessionForKiloSession: vi.fn(),
      getCloudAgentRootSessionSnapshot: vi.fn(),
      listCloudAgentRootSessions: vi.fn(),
      getCloudAgentRootSessionMessages: vi.fn(),
    },
    KILOCODE_BACKEND_BASE_URL: 'https://backend.test',
  } as unknown as Env;
}

function resolveRoot({ kiloSessionId }: { kiloSessionId: string }) {
  if (kiloSessionId === organizationKiloSessionId) {
    return Promise.resolve({ cloudAgentSessionId: organizationCloudAgentSessionId });
  }
  if (kiloSessionId === personalKiloSessionId) {
    return Promise.resolve({ cloudAgentSessionId: personalCloudAgentSessionId });
  }
  return Promise.resolve(null);
}

function postMutation(params: {
  kiloSessionId: string;
  path: 'prompt_async' | 'command';
  body: unknown;
  admitPrompt: KiloFacadeRequestDeps['admitPrompt'];
}) {
  return handleKiloFacadeRequest({
    request: new Request(`http://worker.test/kilo/session/${params.kiloSessionId}/${params.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params.body),
    }),
    env: envStub(),
    userId: callerId,
    authToken,
    // Only admission and root resolution are stubbed: the payer resolution
    // (session access read, balance call) runs for real.
    deps: { resolveRootSessionForKiloSession: resolveRoot, admitPrompt: params.admitPrompt },
  });
}

function balanceRequests(): RecordedRequest[] {
  return recorded.filter(entry => new URL(entry.url).pathname.endsWith('/balance'));
}

beforeAll(async () => {
  await client.db.insert(kilocode_users).values({
    id: callerId,
    google_user_email: `${randomUUID()}@example.test`,
    google_user_name: 'Payer scope fixture',
    google_user_image_url: '',
    stripe_customer_id: '',
  });
  await client.db.insert(organizations).values({
    id: organizationId,
    name: 'Payer scope fixture organization',
    created_by_kilo_user_id: callerId,
  });
  await client.db.insert(organization_memberships).values({
    organization_id: organizationId,
    kilo_user_id: callerId,
    role: 'owner',
  });
  await client.db.insert(cli_sessions_v2).values([
    {
      session_id: organizationKiloSessionId,
      kilo_user_id: callerId,
      cloud_agent_session_id: organizationCloudAgentSessionId,
      organization_id: organizationId,
    },
    {
      session_id: personalKiloSessionId,
      kilo_user_id: callerId,
      cloud_agent_session_id: personalCloudAgentSessionId,
      organization_id: null,
    },
  ]);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    recorded.push({
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
    });
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith('/models/validate')) {
      return Response.json({ valid: true });
    }
    if (pathname.endsWith('/balance')) {
      return Response.json(balanceAnswer);
    }
    throw new Error(`Unexpected outbound request ${request.method} ${request.url}`);
  }) as typeof fetch;
});

afterEach(() => {
  recorded = [];
  balanceAnswer = { balance: 12, isDepleted: false };
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await client.db.delete(cli_sessions_v2).where(eq(cli_sessions_v2.kilo_user_id, callerId));
  await client.db
    .delete(organization_memberships)
    .where(eq(organization_memberships.kilo_user_id, callerId));
  await client.db.delete(organizations).where(inArray(organizations.id, [organizationId]));
  await client.db.delete(kilocode_users).where(eq(kilocode_users.id, callerId));
  await client.pool.end();
});

/**
 * A settled answer becomes a new turn, so the same payer preflight runs before
 * the Session DO admits it. The stub answers the way the DO does: a settled
 * reply returns the continuation intent, and the admit call writes it.
 */
function postAnswer(params: {
  reply: unknown;
  answer: () => Promise<unknown>;
  admitAnswerContinuation: () => Promise<'sent' | 'not_connected'>;
}) {
  const stub = {
    getMetadata: async () => sessionMetadata(personalCloudAgentSessionId, null),
    answer: vi.fn(params.answer),
    admitAnswerContinuation: vi.fn(params.admitAnswerContinuation),
  };
  const env = {
    ...envStub(),
    SANDBOX_SESSION: { idFromName: (name: string) => name, get: () => stub },
  } as unknown as Env;
  return {
    stub,
    response: handleKiloFacadeRequest({
      request: new Request(
        `http://worker.test/kilo/question/q_1/reply?directory=${encodeURIComponent(publicCloudAgentDirectory(personalKiloSessionId))}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params.reply),
        }
      ),
      env,
      userId: callerId,
      authToken,
      // Only root resolution is stubbed; the payer read and balance call are real.
      deps: { resolveRootSessionForKiloSession: resolveRoot },
    }),
  };
}

const CONTINUATION = {
  messageId: 'msg_018f1e2d3c4bAnswerGateAbCdEf',
  turn: { type: 'prompt' as const, prompt: 'Blue' },
  agent: { mode: 'code', model: 'kilo/anthropic/claude-sonnet-4' },
};

describe('facade answer admission against PostgreSQL', () => {
  it('reads the payer balance before it admits a settled answer', async () => {
    const { stub, response } = postAnswer({
      reply: { answers: [['Blue']] },
      answer: async () => ({ result: 'continuation', intent: CONTINUATION }),
      admitAnswerContinuation: async () => 'sent',
    });

    expect((await response).status).toBe(200);
    const [balance] = balanceRequests();
    expect(new URL(balance.url).pathname).toBe('/api/profile/balance');
    expect(balance.headers['x-kilocode-organizationid']).toBeUndefined();
    expect(stub.admitAnswerContinuation).toHaveBeenCalledOnce();
    expect(recorded.some(entry => new URL(entry.url).pathname.endsWith('/models/validate'))).toBe(
      true
    );
  });

  it('refuses a depleted payer and never admits the answer', async () => {
    balanceAnswer = { balance: 0, isDepleted: true };
    const { stub, response } = postAnswer({
      reply: { answers: [['Blue']] },
      answer: async () => ({ result: 'continuation', intent: CONTINUATION }),
      admitAnswerContinuation: async () => 'sent',
    });

    expect((await response).status).toBe(402);
    expect(stub.admitAnswerContinuation).not.toHaveBeenCalled();
    expect(recorded.some(entry => new URL(entry.url).pathname.endsWith('/models/validate'))).toBe(
      false
    );
  });

  it('answers a live question turn without reading the balance', async () => {
    const { stub, response } = postAnswer({
      reply: { answers: [['Blue']] },
      answer: async () => 'sent',
      admitAnswerContinuation: async () => 'sent',
    });

    expect((await response).status).toBe(200);
    expect(balanceRequests()).toEqual([]);
    expect(stub.admitAnswerContinuation).not.toHaveBeenCalled();
  });
});

describe('facade prompt payer scope against PostgreSQL', () => {
  it('charges the organization that owns the session and admits the prompt', async () => {
    const admitPrompt = vi.fn().mockResolvedValue(QUEUED_ADMISSION);

    const response = await postMutation({
      kiloSessionId: organizationKiloSessionId,
      path: 'prompt_async',
      body: { parts: [{ type: 'text', text: 'hello' }] },
      admitPrompt,
    });

    expect(response.status).toBe(204);
    const [balance] = balanceRequests();
    expect(balanceRequests()).toHaveLength(1);
    expect(new URL(balance.url).pathname).toBe('/api/profile/balance');
    expect(balance.headers['x-kilocode-organizationid']).toBe(organizationId);
    expect(balance.headers.authorization).toBe(`Bearer ${authToken}`);
    expect(admitPrompt).toHaveBeenCalledOnce();
    expect(admitPrompt.mock.calls[0]?.[0]).toMatchObject({
      userId: callerId,
      cloudAgentSessionId: organizationCloudAgentSessionId,
    });
  });

  it('charges the personal account when the session has no organization', async () => {
    const admitPrompt = vi.fn().mockResolvedValue(QUEUED_ADMISSION);

    const response = await postMutation({
      kiloSessionId: personalKiloSessionId,
      path: 'prompt_async',
      body: { parts: [{ type: 'text', text: 'hello' }] },
      admitPrompt,
    });

    expect(response.status).toBe(204);
    const [balance] = balanceRequests();
    expect(balanceRequests()).toHaveLength(1);
    expect(balance.headers['x-kilocode-organizationid']).toBeUndefined();
    expect(admitPrompt).toHaveBeenCalledOnce();
    expect(admitPrompt.mock.calls[0]?.[0]).toMatchObject({
      cloudAgentSessionId: personalCloudAgentSessionId,
    });
  });

  it('refuses a depleted organization payer without admitting the prompt', async () => {
    balanceAnswer = { balance: 0, isDepleted: true };
    const admitPrompt = vi.fn().mockResolvedValue(QUEUED_ADMISSION);

    const response = await postMutation({
      kiloSessionId: organizationKiloSessionId,
      path: 'prompt_async',
      body: { parts: [{ type: 'text', text: 'hello' }] },
      admitPrompt,
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_BALANCE_VALIDATION_FAILED',
      message: 'Insufficient credits: $1 minimum required',
    });
    const [balance] = balanceRequests();
    expect(balance.headers['x-kilocode-organizationid']).toBe(organizationId);
    expect(admitPrompt).not.toHaveBeenCalled();
  });

  it('charges the organization that owns the session before admitting a command', async () => {
    const admitPrompt = vi.fn().mockResolvedValue(QUEUED_ADMISSION);

    const response = await postMutation({
      kiloSessionId: organizationKiloSessionId,
      path: 'command',
      body: { command: 'compact' },
      admitPrompt,
    });

    expect(response.status).toBe(204);
    const [balance] = balanceRequests();
    expect(balanceRequests()).toHaveLength(1);
    expect(balance.headers['x-kilocode-organizationid']).toBe(organizationId);
    expect(admitPrompt).toHaveBeenCalledOnce();
    expect(admitPrompt.mock.calls[0]?.[0]).toMatchObject({
      cloudAgentSessionId: organizationCloudAgentSessionId,
    });
  });
});
