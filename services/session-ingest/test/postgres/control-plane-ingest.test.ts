import { cloudAgentSessionScopeHeaders } from '@kilocode/session-ingest-contracts';
import { Socket } from 'node:net';
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import type * as DbClient from '@kilocode/db/client';
import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { createRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import { signKiloToken } from '@kilocode/worker-utils/kilo-token';
import { RUNTIME_PROXY_ATTESTATION_HEADER } from '@kilocode/worker-utils/runtime-proxy-attestation';
import { publishControlPlaneSessionIngest } from '../../../cloud-agent-next/src/sandbox-session/control-plane-ingest';
import { app } from '../../src/app';
import { getSessionExport } from '../../src/services/session-export';
import type { Env } from '../../src/env';

// The Workers test module loader cannot require pg-cloudflare's optional CJS
// export. Supply the runtime's real node:net socket; SQL and storage stay real.
vi.mock('@kilocode/db/client', async importOriginal => {
  const original = await importOriginal<typeof DbClient>();
  return {
    ...original,
    getWorkerDb: (connectionString: string) =>
      original.getWorkerDb(connectionString, {
        stream: () => new Socket(),
      } as Parameters<typeof original.getWorkerDb>[1]),
  };
});

// Requires a migrated test PostgreSQL via the test Hyperdrive binding. All HTTP
// middleware, SQL authorization/lineage, R2 and Durable Objects are production code.
const secret = 'control-plane-ingest-integration-secret';
const db = () => getWorkerDb(env.HYPERDRIVE.connectionString);
const users: string[] = [];
afterEach(async () => {
  for (const userId of users.splice(0)) {
    const rows = await db()
      .select()
      .from(cli_sessions_v2)
      .where(eq(cli_sessions_v2.kilo_user_id, userId));
    for (const row of rows.filter(row => row.parent_session_id !== null)) {
      await db().delete(cli_sessions_v2).where(eq(cli_sessions_v2.session_id, row.session_id));
    }
    await db().delete(cli_sessions_v2).where(eq(cli_sessions_v2.kilo_user_id, userId));
    await db().delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }
});

async function fixture() {
  const userId = `oauth/github:bridge-${crypto.randomUUID()}`;
  users.push(userId);
  const rootKiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
  const eventKiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
  const cloudAgentSessionId = crypto.randomUUID();
  await db()
    .insert(kilocode_users)
    .values({
      id: userId,
      google_user_email: `${crypto.randomUUID()}@example.test`,
      google_user_name: 'Bridge test',
      google_user_image_url: '',
      stripe_customer_id: '',
      api_token_pepper: null,
    });
  await db().insert(cli_sessions_v2).values({
    session_id: rootKiloSessionId,
    kilo_user_id: userId,
    cloud_agent_session_id: cloudAgentSessionId,
  });
  const admission = await signModernKiloToken({
    userId,
    pepper: null,
    secret,
    audience: 'cloud-agent-next',
    tokenPurpose: 'human-api',
    credentialExchange: false,
    expiresInSeconds: 3600,
    extra: {
      runtimeAdmission: { source: 'user', authorizationUserId: userId, authorizationPepper: null },
    },
  });
  const runtime = await createRuntimeAuthorization({
    token: admission.token,
    secret,
    connectionString: env.HYPERDRIVE.connectionString,
    resourceKind: 'cloud-agent-next',
    resourceId: cloudAgentSessionId,
  });
  const bindings = {
    ...env,
    NEXTAUTH_SECRET_PROD: { get: async () => secret },
    INTERNAL_API_SECRET_PROD: { get: async () => 'bridge-internal-secret' },
    DIRECT_INGEST_PERCENT: '100',
    DIRECT_INGEST_USER_IDS: '',
    DIRECT_INGEST_MAX_BYTES: '1048576',
  } as Env;
  const requests: Request[] = [];
  const responses: Response[] = [];
  const params = {
    fetchIngest: async (request: Request) => {
      requests.push(request.clone());
      const response = await app.fetch(request, bindings);
      responses.push(response.clone());
      return response;
    },
    token: runtime.token,
    rootKiloSessionId,
    eventKiloSessionId,
    cloudAgentSessionId,
    directory: '/workspace/bridge',
    internalSecret: 'bridge-internal-secret',
    runtimeContext: { secret, userId, authorization: runtime.authorization, isCurrent: () => true },
    items: [
      {
        type: 'session',
        data: {
          id: eventKiloSessionId,
          parentID: rootKiloSessionId,
          directory: '/workspace/bridge',
        },
      },
      { type: 'message', data: { id: 'msg_child', sessionID: eventKiloSessionId, role: 'user' } },
      {
        type: 'part',
        data: {
          id: 'prt_child',
          messageID: 'msg_child',
          type: 'text',
          text: 'persisted child message',
        },
      },
    ],
  };
  return { params, runtime, bindings, requests, responses, userId };
}

describe('authorized control-plane ingest bridge', () => {
  it.each(['modern', 'legacy'] as const)(
    'persists and exports %s child lineage/messages through the actual app and DO',
    async mode => {
      const f = await fixture();
      if (mode === 'legacy') {
        const legacy = await signKiloToken({
          userId: f.userId,
          pepper: null,
          secret,
          expiresInSeconds: 3600,
        });
        f.params.token = legacy.token;
        await publishControlPlaneSessionIngest({ ...f.params, runtimeContext: undefined });
      } else {
        await publishControlPlaneSessionIngest(f.params);
      }
      expect(f.responses.map(response => response.status)).toEqual([200, 200]);
      expect(
        f.requests.every(request => request.headers.has(RUNTIME_PROXY_ATTESTATION_HEADER))
      ).toBe(mode === 'modern');
      const [child] = await db()
        .select()
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.session_id, f.params.eventKiloSessionId));
      expect(child).toMatchObject({
        parent_session_id: f.params.rootKiloSessionId,
        cloud_agent_session_scope_id: f.params.cloudAgentSessionId,
      });
      const stream = await getSessionExport(f.bindings, f.params.eventKiloSessionId, f.userId);
      expect(stream).not.toBeNull();
      const exported = await new Response(stream).json();
      expect(exported).toMatchObject({
        messages: [{ info: { id: 'msg_child' }, parts: [{ text: 'persisted child message' }] }],
      });
    }
  );

  it('rejects an unattested runtime bearer at the actual middleware', async () => {
    const f = await fixture();
    await publishControlPlaneSessionIngest({ ...f.params, runtimeContext: undefined });
    expect(f.responses.map(response => response.status)).toEqual([401]);
    expect(
      await db()
        .select()
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.session_id, f.params.eventKiloSessionId))
    ).toEqual([]);
  });

  it('rejects foreign root scope at the actual child-create route even with valid proof', async () => {
    const f = await fixture();
    await publishControlPlaneSessionIngest({
      ...f.params,
      fetchIngest: request => {
        const headers = new Headers(request.headers);
        headers.set(cloudAgentSessionScopeHeaders.cloudAgentSessionId, crypto.randomUUID());
        return f.params.fetchIngest(new Request(request, { headers }));
      },
    });
    expect(f.responses[0].status).toBe(404);
    expect(
      await db()
        .select()
        .from(cli_sessions_v2)
        .where(eq(cli_sessions_v2.session_id, f.params.eventKiloSessionId))
    ).toEqual([]);
  });

  it.each([
    'foreign-resource',
    'foreign-owner',
    'revoked',
    'expired',
    'replaced',
    'wrong-audience',
    'forged-signature',
  ] as const)('does not issue proof or publish with %s authority', async failure => {
    const f = await fixture();
    if (failure === 'foreign-resource') f.params.cloudAgentSessionId = crypto.randomUUID();
    if (failure === 'foreign-owner') f.params.runtimeContext.userId = 'foreign-owner';
    if (failure === 'revoked') f.params.runtimeContext.authorization.state = 'revoked';
    if (failure === 'expired')
      f.params.runtimeContext.authorization.delegationExpiresAt = new Date(
        Date.now() - 1000
      ).toISOString();
    if (failure === 'replaced') f.params.runtimeContext.isCurrent = () => false;
    if (failure === 'wrong-audience' || failure === 'forged-signature') {
      const token = await signModernKiloToken({
        userId: f.userId,
        pepper: null,
        secret: failure === 'forged-signature' ? 'wrong-secret' : secret,
        audience: failure === 'wrong-audience' ? 'kilo-api' : 'session-ingest',
        tokenPurpose: 'delegated-workload',
        credentialExchange: false,
        expiresInSeconds: 3600,
        extra: {
          runtimeAuthorization: {
            id: f.runtime.authorization.id,
            resourceKind: 'cloud-agent-next',
            resourceId: f.params.cloudAgentSessionId,
          },
        },
      });
      f.params.token = token.token;
    }
    await publishControlPlaneSessionIngest(f.params);
    expect(f.requests).toEqual([]);
  });
});
