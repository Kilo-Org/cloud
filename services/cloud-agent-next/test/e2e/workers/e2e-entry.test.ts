import { createExecutionContext, env, runInDurableObject, SELF } from 'cloudflare:test';
import { createDrizzleClient } from '@kilocode/db/client';
import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import production from '../../../src/index.js';
import { e2eSurfaceApp } from '../../../src/e2e-surface/app.js';
import type { CloudAgentSession } from '../../../src/persistence/CloudAgentSession.js';
import type { SandboxControl } from '../../../src/persistence/SandboxControl.js';
import { groupedRegisterSessionInput } from '../../helpers/session-setup.js';

const ALLOWED_USER = 'usr_e2e_surface_allowed';
const SESSION_ID = `agent_${crypto.randomUUID()}`;
const KILO_SESSION_ID = 'ses_e2e_surface_0000000000000001';

function pepperFor(userId: string): string {
  return `pepper-${userId}`;
}

let secret: string;
let internalApiSecret: string;
const db = createDrizzleClient({
  connectionString: env.HYPERDRIVE.connectionString,
  poolConfig: { max: 1 },
});

function tokenFor(userId: string): string {
  return jwt.sign(
    {
      env: 'development',
      kiloUserId: userId,
      apiTokenPepper: pepperFor(userId),
      version: 3,
      tokenSource: 'cloud-agent',
    },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

/** A structurally valid JWT signed with the wrong key. */
function invalidToken(): string {
  return jwt.sign(
    {
      env: 'development',
      kiloUserId: ALLOWED_USER,
      apiTokenPepper: pepperFor(ALLOWED_USER),
      version: 3,
      tokenSource: 'cloud-agent',
    },
    'not-the-nextauth-secret',
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

type Credentials = { token?: string; secret?: string; body?: string };

function surfaceRequest(method: string, path: string, credentials: Credentials = {}): Request {
  const headers: Record<string, string> = {};
  if (credentials.token !== undefined) headers.Authorization = `Bearer ${credentials.token}`;
  if (credentials.secret !== undefined) headers['x-internal-api-key'] = credentials.secret;
  if (credentials.body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://worker.test${path}`, {
    method,
    headers,
    ...(credentials.body === undefined ? {} : { body: credentials.body }),
  });
}

const ALLOCATION_PATH = `/__e2e/inspect/allocation/${SESSION_ID}`;

/** Every non-exempt route shares the same two-gate contract. */
const NON_EXEMPT_ROUTES: Array<[string, string]> = [
  ['GET', ALLOCATION_PATH],
  ['POST', '/__e2e/callbacks'],
  ['GET', '/__e2e/callbacks/unknown-token'],
  ['DELETE', '/__e2e/callbacks/unknown-token'],
];

function allocationRequest(sessionId: string, token?: string, presentedSecret?: string): Request {
  return surfaceRequest('GET', `/__e2e/inspect/allocation/${sessionId}`, {
    ...(token === undefined ? {} : { token }),
    ...(presentedSecret === undefined ? {} : { secret: presentedSecret }),
  });
}

beforeAll(async () => {
  const configuredSecret = env.NEXTAUTH_SECRET;
  if (typeof configuredSecret !== 'string' || configuredSecret.length === 0) {
    throw new Error('test config did not bind a string NEXTAUTH_SECRET');
  }
  secret = configuredSecret;

  const boundInternalSecret = env.INTERNAL_API_SECRET;
  if (typeof boundInternalSecret !== 'string' || boundInternalSecret.length === 0) {
    throw new Error('test config did not bind a string INTERNAL_API_SECRET');
  }
  internalApiSecret = boundInternalSecret;

  await db.db
    .insert(kilocode_users)
    .values({
      id: ALLOWED_USER,
      google_user_email: `${ALLOWED_USER}@e2e.test`,
      google_user_name: 'E2E Surface',
      google_user_image_url: 'https://example.test/avatar.png',
      stripe_customer_id: `cus_${ALLOWED_USER}`,
      api_token_pepper: pepperFor(ALLOWED_USER),
      is_admin: false,
    })
    .onConflictDoNothing();

  await db.db
    .insert(cli_sessions_v2)
    .values({
      session_id: KILO_SESSION_ID,
      kilo_user_id: ALLOWED_USER,
      cloud_agent_session_id: SESSION_ID,
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.db
    .delete(cli_sessions_v2)
    .where(inArray(cli_sessions_v2.kilo_user_id, [ALLOWED_USER]))
    .catch(() => undefined);
  await db.db
    .delete(kilocode_users)
    .where(inArray(kilocode_users.id, [ALLOWED_USER]))
    .catch(() => undefined);
  await db.pool.end().catch(() => undefined);
});

describe('e2e surface auth chain', () => {
  it('404s a non-e2e path on the production app', async () => {
    const response = await SELF.fetch('https://worker.test/definitely-not-a-route');
    expect(response.status).toBe(404);
  });

  it('404s an /__e2e/* path on the production app', async () => {
    const response = await production.fetch(
      new Request(`https://worker.test/__e2e/inspect/allocation/${SESSION_ID}`, {
        headers: {
          Authorization: `Bearer ${tokenFor(ALLOWED_USER)}`,
          'x-internal-api-key': env.INTERNAL_API_SECRET as string,
        },
      }),
      env,
      createExecutionContext()
    );
    expect(response.status).toBe(404);
  });

  it('rejects both gates independently on every non-exempt route', async () => {
    const valid = tokenFor(ALLOWED_USER);
    for (const [method, path] of NON_EXEMPT_ROUTES) {
      const cases: Array<[string, Credentials]> = [
        ['valid JWT + absent key', { token: valid }],
        ['valid JWT + wrong key', { token: valid, secret: 'wrong-key-value' }],
        ['correct key + absent JWT', { secret: internalApiSecret }],
        ['correct key + invalid JWT', { token: invalidToken(), secret: internalApiSecret }],
      ];
      for (const [label, credentials] of cases) {
        const response = await SELF.fetch(surfaceRequest(method, path, credentials));
        expect(response.status, `${method} ${path} (${label})`).toBe(401);
      }
    }
  });

  it('fails closed on an unset or empty Worker binding with a non-empty presented key', async () => {
    for (const binding of [undefined, '']) {
      const response = await e2eSurfaceApp.fetch(
        allocationRequest(SESSION_ID, tokenFor(ALLOWED_USER), 'presented-but-unconfigured-key'),
        { ...env, INTERNAL_API_SECRET: binding },
        createExecutionContext()
      );
      expect(response.status, `binding=${String(binding)}`).toBe(401);
    }
  });

  it('rejects the secret gate before Hyperdrive is dereferenced', async () => {
    const valid = tokenFor(ALLOWED_USER);
    for (const presented of [undefined, 'wrong-key-value']) {
      const response = await e2eSurfaceApp.fetch(
        allocationRequest(SESSION_ID, valid, presented),
        { ...env, HYPERDRIVE: undefined },
        createExecutionContext()
      );
      expect(response.status, `presented=${String(presented)}`).toBe(401);
    }
  });
});

describe('internal tRPC reachability (deliberately widened by the single secret)', () => {
  const ABSENT_SESSION_ID = `agent_${crypto.randomUUID()}`;

  it('reaches updateSession with the secret and a valid JWT and reports the handler error', async () => {
    // Intentional: with the e2e secret plus any valid JWT, `updateSession` is
    // reachable. The assertion is handler-originated (the DO reports its own
    // "Session metadata is not available" for an absent session), not merely
    // "not 401" — 404, a 500 from an unset secret and unrelated failures all
    // satisfy "not 401".
    const response = await SELF.fetch(
      surfaceRequest('POST', '/trpc/updateSession', {
        token: tokenFor(ALLOWED_USER),
        secret: internalApiSecret,
        body: JSON.stringify({ cloudAgentSessionId: ABSENT_SESSION_ID }),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe('Session metadata is not available');
  });

  it('rejects updateSession without the secret with the internal-key error', async () => {
    const response = await SELF.fetch(
      surfaceRequest('POST', '/trpc/updateSession', {
        token: tokenFor(ALLOWED_USER),
        body: JSON.stringify({ cloudAgentSessionId: ABSENT_SESSION_ID }),
      })
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe('Invalid or missing internal API key');
  });
});

describe('allocation inspect', () => {
  it('returns exactly the logical id and the persisted physical projection', async () => {
    const sessionId = `agent_${crypto.randomUUID()}`;
    const kiloSessionId = `ses_e2e_surface_alloc_${crypto.randomUUID().slice(0, 8)}`;
    const sandboxId = 'usr-123456789abc';
    const providerRef = 'e2e-provider-ref-2';

    await db.db
      .insert(cli_sessions_v2)
      .values({
        session_id: kiloSessionId,
        kilo_user_id: ALLOWED_USER,
        cloud_agent_session_id: sessionId,
      })
      .onConflictDoNothing();

    await runInDurableObject(
      env.CLOUD_AGENT_SESSION.getByName(`${ALLOWED_USER}:${sessionId}`),
      async instance => {
        const session = instance as unknown as CloudAgentSession;
        const registered = await session.registerSession(
          groupedRegisterSessionInput({
            sessionId,
            userId: ALLOWED_USER,
            prompt: 'echo:hi',
            mode: 'code',
            model: 'kilo/fake-deterministic',
            kiloSessionId,
            sandboxId,
          })
        );
        if (!registered.success) {
          throw new Error(`registerSession failed: ${registered.error}`);
        }
        const ready = await session.recordSessionReady({
          workspacePath: `/workspace/${ALLOWED_USER}/sessions/${sessionId}`,
          sandboxId,
          sessionHome: `/home/${sessionId}`,
          branchName: `session/${sessionId}`,
          kiloSessionId,
        });
        if (!ready.success) {
          throw new Error(`recordSessionReady failed: ${ready.error}`);
        }
      }
    );

    await runInDurableObject(env.SANDBOX_CONTROL.getByName(sandboxId), async instance => {
      const control = instance as unknown as SandboxControl;
      await control.claimCreate('e2e-intent');
      await control.confirmInstance(providerRef);
    });

    const response = await SELF.fetch(
      allocationRequest(sessionId, tokenFor(ALLOWED_USER), internalApiSecret)
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'logicalSandboxId',
      'physicalProviderRef',
      'physicalState',
    ]);
    expect(body.logicalSandboxId).toBe(sandboxId);
    expect(body.physicalProviderRef).toBe(providerRef);
    expect(body.physicalState).toBe('running');

    await db.db
      .delete(cli_sessions_v2)
      .where(eq(cli_sessions_v2.cloud_agent_session_id, sessionId));
  });

  it('reports the persisted creating state before a provider reference exists', async () => {
    const sessionId = `agent_${crypto.randomUUID()}`;
    const kiloSessionId = `ses_e2e_surface_creating_${crypto.randomUUID().slice(0, 8)}`;
    const sandboxId = 'usr-000000000abc';

    await db.db
      .insert(cli_sessions_v2)
      .values({
        session_id: kiloSessionId,
        kilo_user_id: ALLOWED_USER,
        cloud_agent_session_id: sessionId,
      })
      .onConflictDoNothing();

    await runInDurableObject(
      env.CLOUD_AGENT_SESSION.getByName(`${ALLOWED_USER}:${sessionId}`),
      async instance => {
        const session = instance as unknown as CloudAgentSession;
        const registered = await session.registerSession(
          groupedRegisterSessionInput({
            sessionId,
            userId: ALLOWED_USER,
            prompt: 'echo:hi',
            mode: 'code',
            model: 'kilo/fake-deterministic',
            kiloSessionId,
            sandboxId,
          })
        );
        if (!registered.success) {
          throw new Error(`registerSession failed: ${registered.error}`);
        }
        const ready = await session.recordSessionReady({
          workspacePath: `/workspace/${ALLOWED_USER}/sessions/${sessionId}`,
          sandboxId,
          sessionHome: `/home/${sessionId}`,
          branchName: `session/${sessionId}`,
          kiloSessionId,
        });
        if (!ready.success) {
          throw new Error(`recordSessionReady failed: ${ready.error}`);
        }
      }
    );

    await runInDurableObject(env.SANDBOX_CONTROL.getByName(sandboxId), async instance => {
      const control = instance as unknown as SandboxControl;
      await control.claimCreate('e2e-creating-intent');
    });

    const response = await SELF.fetch(
      allocationRequest(sessionId, tokenFor(ALLOWED_USER), internalApiSecret)
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.physicalProviderRef).toBeNull();
    expect(body.physicalState).toBe('creating');

    await db.db
      .delete(cli_sessions_v2)
      .where(eq(cli_sessions_v2.cloud_agent_session_id, sessionId));
  });
});
