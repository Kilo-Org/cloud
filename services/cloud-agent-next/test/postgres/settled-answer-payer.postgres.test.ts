/**
 * A settled answer becomes a new turn, so the tRPC answer mutation and the Kilo
 * facade reply route each run the payer preflight before the Session DO admits
 * the continuation. Both routes are driven here against the real session
 * ownership record, so the payer that reaches the balance endpoint is the payer
 * the seeded session belongs to.
 */
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cli_sessions_v2,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { publicCloudAgentDirectory } from '../../src/kilo-facade/public-sdk-projection.js';
import { t } from '../../src/router/auth.js';
import { createSessionQuestionHandlers } from '../../src/router/handlers/session-questions.js';
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

const callerId = `oauth/settled-answer-payer-${randomUUID()}`;
const organizationId = randomUUID();
const organizationKiloSessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
const organizationCloudAgentSessionId = `workspace_${randomUUID()}`;
const personalKiloSessionId = `ses_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
const personalCloudAgentSessionId = `workspace_${randomUUID()}`;

// This suite drives the request path after authentication, so any signed token
// stands in for the caller's bearer. It carries no runtime-admission claim, so
// the send path renews no workspace authority.
const authToken = jwt.sign({ sub: callerId }, 'settled-answer-payer-test-secret');

type RecordedRequest = { url: string; headers: Record<string, string> };

type SessionStub = {
  getMetadata: () => Promise<unknown>;
  answer: Mock;
  admitAnswerContinuation: Mock;
};

const CONTINUATION = {
  messageId: 'msg_018f1e2d3c4bSettledAnswerPayer',
  turn: { type: 'prompt' as const, prompt: 'Blue' },
  agent: { mode: 'code', model: 'kilo/anthropic/claude-sonnet-4' },
};

const originalFetch = globalThis.fetch;
let recorded: RecordedRequest[] = [];
let balanceAnswer: { balance: number; isDepleted: boolean } = { balance: 12, isDepleted: false };
let stubs = new Map<string, SessionStub>();

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

/** The DO answers the way a settled question does: it hands back the continuation. */
function sessionStub(sessionId: string, sessionOrganizationId: string | null): SessionStub {
  return {
    getMetadata: async () => sessionMetadata(sessionId, sessionOrganizationId),
    answer: vi.fn(async () => ({ result: 'continuation', intent: CONTINUATION })),
    admitAnswerContinuation: vi.fn(async () => 'sent'),
  };
}

function resetStubs(): void {
  stubs = new Map([
    [organizationCloudAgentSessionId, sessionStub(organizationCloudAgentSessionId, organizationId)],
    [personalCloudAgentSessionId, sessionStub(personalCloudAgentSessionId, null)],
  ]);
}

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

function balanceRequests(): RecordedRequest[] {
  return recorded.filter(entry => new URL(entry.url).pathname.endsWith('/balance'));
}

function catalogueRequests(): RecordedRequest[] {
  return recorded.filter(entry => new URL(entry.url).pathname.endsWith('/models/validate'));
}

function answerStub(sessionId: string): SessionStub {
  const stub = stubs.get(sessionId);
  if (!stub) throw new Error(`No session stub for ${sessionId}`);
  return stub;
}

function answerCaller() {
  const handlers = createSessionQuestionHandlers();
  const router = t.router({ answerQuestion: handlers.answerQuestion });
  // Only the DO, the balance endpoint and the catalogue are stubbed: the
  // session access read against PostgreSQL runs for real.
  return router.createCaller({
    userId: callerId,
    authToken,
    request: new Request('https://worker.test/trpc/sessionQuestions.answerQuestion'),
    env: envStub(),
  });
}

function postAnswer(params: { kiloSessionId: string; reply: unknown }) {
  return handleKiloFacadeRequest({
    request: new Request(
      `http://worker.test/kilo/question/q_1/reply?directory=${encodeURIComponent(publicCloudAgentDirectory(params.kiloSessionId))}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params.reply),
      }
    ),
    env: envStub(),
    userId: callerId,
    authToken,
    // Only root resolution is stubbed; the payer read and balance call are real.
    deps: { resolveRootSessionForKiloSession: resolveRoot },
  });
}

beforeAll(async () => {
  await client.db.insert(kilocode_users).values({
    id: callerId,
    google_user_email: `${randomUUID()}@example.test`,
    google_user_name: 'Settled answer payer fixture',
    google_user_image_url: '',
    stripe_customer_id: '',
  });
  await client.db.insert(organizations).values({
    id: organizationId,
    name: 'Settled answer payer fixture organization',
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

beforeEach(() => {
  resetStubs();
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

describe('settled answer payer on the tRPC answer mutation', () => {
  it('charges the organization that owns the session when the tRPC answer admits a settled turn', async () => {
    const result = await answerCaller().answerQuestion({
      sessionId: organizationCloudAgentSessionId,
      questionId: 'q_1',
      answers: [['Blue']],
    });

    expect(result).toEqual({ success: true });
    const balances = balanceRequests();
    expect(balances).toHaveLength(1);
    expect(new URL(balances[0]?.url ?? '').pathname).toBe('/api/profile/balance');
    expect(balances[0]?.headers['x-kilocode-organizationid']).toBe(organizationId);
    expect(catalogueRequests()).toHaveLength(1);
    expect(
      answerStub(organizationCloudAgentSessionId).admitAnswerContinuation
    ).toHaveBeenCalledOnce();
  });

  it('charges the personal account when the session has no organization on the tRPC answer route', async () => {
    const result = await answerCaller().answerQuestion({
      sessionId: personalCloudAgentSessionId,
      questionId: 'q_1',
      answers: [['Blue']],
    });

    expect(result).toEqual({ success: true });
    const balances = balanceRequests();
    expect(balances).toHaveLength(1);
    expect(balances[0]?.headers['x-kilocode-organizationid']).toBeUndefined();
    expect(answerStub(personalCloudAgentSessionId).admitAnswerContinuation).toHaveBeenCalledOnce();
  });

  it('refuses a depleted organization payer on the tRPC answer route and keeps the interaction answerable', async () => {
    balanceAnswer = { balance: 0, isDepleted: true };

    await expect(
      answerCaller().answerQuestion({
        sessionId: organizationCloudAgentSessionId,
        questionId: 'q_1',
        answers: [['Blue']],
      })
    ).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });

    const balances = balanceRequests();
    expect(balances).toHaveLength(1);
    expect(balances[0]?.headers['x-kilocode-organizationid']).toBe(organizationId);
    expect(catalogueRequests()).toHaveLength(0);
    expect(
      answerStub(organizationCloudAgentSessionId).admitAnswerContinuation
    ).not.toHaveBeenCalled();
  });
});

describe('settled answer payer on the facade answer route', () => {
  it('charges the organization that owns the session on the facade answer route', async () => {
    const response = await postAnswer({
      kiloSessionId: organizationKiloSessionId,
      reply: { answers: [['Blue']] },
    });

    expect(response.status).toBe(200);
    const balances = balanceRequests();
    expect(balances).toHaveLength(1);
    expect(new URL(balances[0]?.url ?? '').pathname).toBe('/api/profile/balance');
    expect(balances[0]?.headers['x-kilocode-organizationid']).toBe(organizationId);
    expect(
      answerStub(organizationCloudAgentSessionId).admitAnswerContinuation
    ).toHaveBeenCalledOnce();
  });
});
