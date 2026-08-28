import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { DrizzleClient } from '@kilocode/db/client';
import type * as HeadersModule from 'next/headers';
import type * as TrpcModule from '@trpc/server';
import type * as RuntimeModule from '@kilocode/db/quick-chat-runtime';
import type * as UserModule from '@/lib/user/server';
import type * as ClientsModule from './clients';
import type * as AuthorizationModule from './authorization';
import type { HarnessCapabilityScope } from './authorization';
import jwt from 'jsonwebtoken';
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  agent_harness_clients,
  type agent_harness_conversation_grants,
  device_sessions,
  kilocode_users,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';

let integrationDatabase: DrizzleClient['db'] | undefined;

jest.mock('@/lib/config.server', () => ({ NEXTAUTH_SECRET: 'harness-test-signing-key' }));
jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('next/headers', () => ({ headers: jest.fn() }));
jest.mock('@/lib/drizzle', () => ({
  get db() {
    return integrationDatabase ?? primary;
  },
  get readDb() {
    throw new Error('Authorization must not use a replica');
  },
}));
jest.mock('@/lib/trpc/init', () => ({
  baseProcedure: jest.requireActual<typeof TrpcModule>('@trpc/server').initTRPC.create().procedure,
}));
jest.mock('@/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest.fn(),
}));
jest.mock('@/lib/admin/admin-access-log', () => ({
  elevateViaKiloAdmin: async (_ctx: unknown, input: { grant: string }) => input.grant,
  organizationTarget: (id: string) => id,
}));
jest.mock('@kilocode/db/quick-chat-runtime', () => ({
  ...jest.requireActual<typeof RuntimeModule>('@kilocode/db/quick-chat-runtime'),
  createQuickChatRuntime: () => ({
    lookupThread: async (authority: unknown) => {
      if (storageError) throw storageError;
      return active ? authority : null;
    },
  }),
}));

// Load server modules only after mock registration; the repository transformer does not hoist these calls.
const { headers } = jest.requireMock<typeof HeadersModule>('next/headers');
const { getUserFromAuth } = jest.requireMock<typeof UserModule>('@/lib/user/server');
const { applyHarnessClientCommand, authenticateHarnessIdentity, requireHarnessClient } =
  jest.requireActual<typeof ClientsModule>('./clients');
const {
  authorizeHarnessCapability,
  authorizeHarnessRequest,
  createHarnessGrant,
  harnessInputDigest,
  mintHarnessCapability,
} = jest.requireActual<typeof AuthorizationModule>('./authorization');

const conversationId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const grantId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const request = { conversationId, clientId };
const registration = {
  type: 'registerClient',
  protocolVersion: 1,
  commandId: otherId,
  clientId,
  kind: 'browser',
  supportedTools: [{ name: 'app.openScreen', version: '1' }],
};
const now = () => new Date(Date.now()).toISOString();
let user: User;
let client: typeof agent_harness_clients.$inferSelect | undefined;
let grant: typeof agent_harness_conversation_grants.$inferSelect | undefined;
let organizationId: string | null;
let active: boolean;
let directRoles: string[];
let inheritedRoles: string[];
let session: typeof device_sessions.$inferSelect | undefined;
let storageError: Error | undefined;
const inserted = jest.fn<(table: unknown, values: any) => Promise<any[]>>();
const dialect = new PgDialect();
const parameters = (condition?: SQL) => (condition ? dialect.sqlToQuery(condition).params : []);

// These fakes exercise authorization decisions and lost-conflict outcomes, not PostgreSQL lock scheduling.
const primary = {
  transaction: async (work: (tx: unknown) => Promise<unknown>) => work(primary),
  query: {
    kilocode_users: { findFirst: async () => ({ ...user }) },
    agent_harness_conversation_registry: {
      findFirst: async () => ({
        thread_id: conversationId,
        user_id: user.id,
        organization_id: organizationId,
        generation: 0,
      }),
    },
    agent_harness_conversation_grants: {
      findFirst: async ({ where }: { where: SQL }) =>
        grant && parameters(where).includes(grant.id) ? { ...grant } : undefined,
    },
  },
  select: () => ({
    from: (table: unknown) => {
      let filter: unknown[] = [];
      let joined: unknown[] = [];
      const rows = () => {
        if (table === kilocode_users) return filter.includes(user.id) ? [{ ...user }] : [];
        if (table === agent_harness_clients)
          return client && filter.includes(client.id) ? [{ ...client }] : [];
        if (table === device_sessions)
          return session && filter.includes(session.id) ? [{ ...session }] : [];
        if (table === organization_memberships) return directRoles.map(role => ({ role }));
        if (table === organizations)
          return inheritedRoles.filter(role => joined.includes(role)).map(role => ({ role }));
        throw new Error('Unexpected primary query');
      };
      const query = {
        where: (condition: SQL) => {
          filter = parameters(condition);
          return query;
        },
        innerJoin: (_table: unknown, condition: SQL) => {
          joined = parameters(condition);
          return query;
        },
        for: async () => rows(),
        then: (resolve: any, reject: any) => Promise.resolve(rows()).then(resolve, reject),
      };
      return query;
    },
  }),
  insert: (table: unknown) => ({
    values: (values: unknown) => {
      const query = { onConflictDoUpdate: () => query, returning: () => inserted(table, values) };
      return query;
    },
  }),
  update: () => ({
    set: () => ({
      where: async () => {
        if (grant) grant.revoked_at = now();
      },
    }),
  }),
};

const scope = (): HarnessCapabilityScope => ({
  audience: 'agent-harness:operations',
  conversationId,
  operation: 'kilo.members',
  definitionVersion: '1',
  inputDigest: harnessInputDigest({}),
  dispatchId: otherId,
  target: { kind: 'backend' },
});
const localScope = (): HarnessCapabilityScope => ({
  ...scope(),
  operation: 'app.openScreen',
  target: { kind: 'client', clientId },
});
const denied = { code: 'FORBIDDEN' };

describe('harness authorization', () => {
  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-28T10:00:00Z'));
    user = {
      id: 'oauth/github:harness-user',
      blocked_reason: null,
      is_admin: false,
      api_token_pepper: null,
      web_session_pepper: null,
    } as User;
    client = undefined;
    grant = undefined;
    organizationId = null;
    active = true;
    directRoles = ['member'];
    inheritedRoles = [];
    session = undefined;
    storageError = undefined;
    jest.mocked(headers).mockResolvedValue(new Headers() as Awaited<ReturnType<typeof headers>>);
    jest.mocked(getUserFromAuth).mockResolvedValue({ user: { ...user }, authFailedResponse: null });
    inserted.mockReset().mockImplementation(async (table, values) => {
      if (table === agent_harness_clients) {
        client = { ...values, created_at: now(), revoked_at: values.revoked_at ? now() : null };
        return [client];
      }
      grant = { ...values, id: grantId, created_at: '2026-08-28 10:00:00+00', revoked_at: null };
      return [grant];
    });
    await applyHarnessClientCommand(registration);
    await createHarnessGrant({ ...request, expiresAt: '2026-08-28T11:00:00Z' });
  });
  afterEach(() => jest.restoreAllMocks());

  it('reloads the owner and constructs audit context without stored or caller-authored authority', async () => {
    jest.mocked(getUserFromAuth).mockResolvedValue({
      user: { ...user, is_admin: true },
      authFailedResponse: null,
      tokenSource: 'unrelated',
    });
    const result = await authorizeHarnessRequest(request);
    expect(result.ctx).toEqual({
      user,
      authViaToken: true,
      tokenSource: 'agent-harness',
      ip: null,
    });
    expect(grant).toEqual({
      id: grantId,
      thread_id: conversationId,
      user_id: user.id,
      client_id: clientId,
      generation: 0,
      expires_at: '2026-08-28T11:00:00Z',
      created_at: '2026-08-28 10:00:00+00',
      revoked_at: null,
    });
    await expect(
      authorizeHarnessRequest({ ...request, actorUserId: 'arbitrary-actor' })
    ).rejects.toThrow();
  });

  it.each([
    ['audience', { audience: 'another-service' }],
    ['digest', { inputDigest: harnessInputDigest({ changed: true }) }],
    ['target', { target: { kind: 'client', clientId: otherId } }],
    ['conversation', { conversationId: otherId }],
    ['dispatch', { dispatchId: grantId }],
    ['operation', { operation: 'kilo.invite' }],
    ['definition', { definitionVersion: '2' }],
  ])('rejects a signed capability with a forged %s', async (_name, change) => {
    const token = await mintHarnessCapability(grantId, scope());
    const claims = jwt.decode(token) as jwt.JwtPayload;
    const forged = jwt.sign(
      { ...claims, scope: { ...claims.scope, ...(change as object) } },
      'harness-test-signing-key'
    );
    await expect(authorizeHarnessCapability(forged, scope())).rejects.toMatchObject(denied);
  });

  it('rejects a service token, invalid signature, forged owner, and an unknown grant', async () => {
    const token = await mintHarnessCapability(grantId, scope());
    const claims = jwt.decode(token) as jwt.JwtPayload;
    for (const forged of [
      jwt.sign({ kiloUserId: user.id }, 'harness-test-signing-key'),
      jwt.sign(claims, 'wrong-key'),
      jwt.sign(
        { ...claims, authority: { ...claims.authority, userId: 'another-user' } },
        'harness-test-signing-key'
      ),
      jwt.sign({ ...claims, grantId: otherId }, 'harness-test-signing-key'),
    ])
      await expect(authorizeHarnessCapability(forged, scope())).rejects.toMatchObject(denied);
  });

  it('rejects an expired capability while its durable grant remains current', async () => {
    const token = await mintHarnessCapability(grantId, scope());
    jest.mocked(Date.now).mockReturnValue(Date.parse('2026-08-28T10:01:00Z'));
    await expect(authorizeHarnessCapability(token, scope())).rejects.toMatchObject(denied);
    expect(await mintHarnessCapability(grantId, scope())).not.toBe(token);
  });

  it('never lets a capability outlive its durable grant', async () => {
    grant!.expires_at = '2026-08-28 10:00:02+00';
    const token = await mintHarnessCapability(grantId, scope());
    jest.mocked(Date.now).mockReturnValue(Date.parse('2026-08-28T10:00:02Z'));
    expect(() => jwt.verify(token, 'harness-test-signing-key')).toThrow('jwt expired');
    await expect(mintHarnessCapability(grantId, scope())).rejects.toMatchObject(denied);
  });

  it.each(['owner', 'admin', 'billing_manager'])(
    'honors the current inherited %s role',
    async role => {
      organizationId = otherId;
      directRoles = [];
      inheritedRoles = [role];
      expect((await authorizeHarnessRequest(request)).role).toBe(role);
    }
  );

  it('does not inherit a parent member role or retain a removed membership', async () => {
    organizationId = otherId;
    const token = await mintHarnessCapability(grantId, scope());
    directRoles = [];
    inheritedRoles = ['member'];
    await expect(authorizeHarnessCapability(token, scope())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    directRoles = ['owner'];
    await expect(mintHarnessCapability(grantId, scope())).rejects.toMatchObject(denied);
  });

  it('fences retired contexts and blocked accounts before backend effects', async () => {
    const token = await mintHarnessCapability(grantId, scope());
    active = false;
    await expect(authorizeHarnessCapability(token, scope())).rejects.toMatchObject(denied);
    active = true;
    await expect(mintHarnessCapability(grantId, scope())).rejects.toMatchObject(denied);
    user.blocked_reason = 'blocked';
    await expect(authorizeHarnessRequest(request)).rejects.toMatchObject(denied);
  });

  it('preserves retryable storage failures without revoking the execution grant', async () => {
    const token = await mintHarnessCapability(grantId, scope());
    storageError = new Error('Primary temporarily unavailable');
    await expect(authorizeHarnessCapability(token, scope())).rejects.toBe(storageError);
    storageError = undefined;
    expect((await authorizeHarnessCapability(token, scope())).ctx.user.id).toBe(user.id);
  });

  it('keeps accepted backend work authorized after sign-out but refuses new access and local effects', async () => {
    const backend = await mintHarnessCapability(grantId, scope());
    const local = await mintHarnessCapability(grantId, localScope());
    await applyHarnessClientCommand({
      type: 'revokeClient',
      protocolVersion: 1,
      commandId: otherId,
      clientId,
    });
    expect((await authorizeHarnessCapability(backend, scope())).grant.revoked_at).toBeNull();
    await expect(authorizeHarnessRequest(request)).rejects.toMatchObject(denied);
    await expect(
      createHarnessGrant({ ...request, expiresAt: '2026-08-28T11:00:00Z' })
    ).rejects.toMatchObject(denied);
    await expect(authorizeHarnessCapability(local, localScope())).rejects.toMatchObject(denied);
    jest.mocked(getUserFromAuth).mockResolvedValue({ user: null, authFailedResponse: {} as never });
    expect(
      (await authorizeHarnessCapability(await mintHarnessCapability(grantId, scope()), scope())).ctx
        .user.id
    ).toBe(user.id);
  });

  it('rejects withdrawn or wrongly targeted local capabilities', async () => {
    const token = await mintHarnessCapability(grantId, localScope());
    client!.supported_tools = [];
    await expect(authorizeHarnessCapability(token, localScope())).rejects.toMatchObject(denied);
    await expect(
      mintHarnessCapability(grantId, { ...localScope(), target: { kind: 'backend' } })
    ).rejects.toMatchObject(denied);
  });

  it('rechecks a revoked device session without cancelling accepted backend work', async () => {
    session = {
      id: otherId,
      kilo_user_id: user.id,
      revoked_at: null,
    } as typeof device_sessions.$inferSelect;
    jest
      .mocked(headers)
      .mockResolvedValue(
        new Headers({ authorization: 'Bearer not-stored' }) as Awaited<ReturnType<typeof headers>>
      );
    jest
      .mocked(getUserFromAuth)
      .mockResolvedValue({ user, deviceSessionId: otherId, authFailedResponse: null });
    const mobileClientId = '55555555-5555-4555-8555-555555555555';
    await applyHarnessClientCommand({ ...registration, clientId: mobileClientId, kind: 'mobile' });
    await createHarnessGrant({
      conversationId,
      clientId: mobileClientId,
      expiresAt: '2026-08-28T11:00:00Z',
    });
    const mobileScope: HarnessCapabilityScope = {
      ...localScope(),
      target: { kind: 'client', clientId: mobileClientId },
    };
    const backend = await mintHarnessCapability(grantId, scope());
    const local = await mintHarnessCapability(grantId, mobileScope);
    session.revoked_at = now();
    await expect(
      authorizeHarnessRequest({ conversationId, clientId: mobileClientId })
    ).rejects.toMatchObject(denied);
    await expect(authorizeHarnessCapability(local, mobileScope)).rejects.toMatchObject(denied);
    expect((await authorizeHarnessCapability(backend, scope())).ctx.user.id).toBe(user.id);
    expect(JSON.stringify({ client, grant })).not.toContain('not-stored');
  });

  it('rejects a stale browser session and a bearer without a device session', async () => {
    user.web_session_pepper = otherId;
    await expect(authorizeHarnessRequest(request)).rejects.toMatchObject(denied);
    jest
      .mocked(headers)
      .mockResolvedValue(
        new Headers({ authorization: 'Bearer service' }) as Awaited<ReturnType<typeof headers>>
      );
    await expect(applyHarnessClientCommand(registration)).rejects.toMatchObject(denied);
  });

  it('refuses a registration excluded by the canonical row', async () => {
    // PostgreSQL's conditional upsert returns no row to a conflicting or revoked registration.
    inserted.mockResolvedValueOnce([]);
    await expect(applyHarnessClientCommand(registration)).rejects.toMatchObject(denied);
  });

  it('refuses an in-flight registration when revocation wins its database conflict', async () => {
    const reached = Promise.withResolvers<void>();
    const conflict = Promise.withResolvers<any[]>();
    inserted.mockImplementationOnce(async () => {
      reached.resolve();
      return conflict.promise;
    });
    const registering = applyHarnessClientCommand(registration);
    const refused = expect(registering).rejects.toMatchObject(denied);
    await reached.promise;
    const revoked = await applyHarnessClientCommand({
      type: 'revokeClient',
      protocolVersion: 1,
      commandId: grantId,
      clientId,
    });
    conflict.resolve([]);
    await refused;
    expect(revoked.revokedAt).toBe('2026-08-28T10:00:00.000Z');
    await expect(authorizeHarnessRequest(request)).rejects.toMatchObject(denied);
  });
});

// Ordinary web CI runs this suite. The explicit local name filter excludes it without disabling CI coverage.
// Authentication remains stubbed; client queries, transactions, and conflict decisions use PostgreSQL.
describe('harness client PostgreSQL', () => {
  let database: DrizzleClient;
  let owner: User;
  let otherOwner: User;
  let registeredClientId: string;
  let userIds: string[] = [];

  beforeAll(async () => {
    const { createDrizzleClient, computeDatabaseUrl } = await import('@kilocode/db');
    database = createDrizzleClient({
      connectionString: computeDatabaseUrl(),
      poolConfig: {
        application_name: 'harness-authorization-test',
        max: 3,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 7_500,
      },
    });
    integrationDatabase = database.db;
  });

  beforeEach(async () => {
    registeredClientId = crypto.randomUUID();
    userIds = Array.from({ length: 2 }, () => `oauth/github:${crypto.randomUUID()}`);
    [owner, otherOwner] = await database.db
      .insert(kilocode_users)
      .values(
        userIds.map(id => ({
          id,
          google_user_email: `${crypto.randomUUID()}@example.com`,
          google_user_name: 'Harness authorization test',
          google_user_image_url: '',
          stripe_customer_id: `cus_${crypto.randomUUID()}`,
        }))
      )
      .returning();
    jest.mocked(headers).mockResolvedValue(new Headers() as Awaited<ReturnType<typeof headers>>);
    authenticateAs(owner);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // User deletion cascades to this test's clients and device sessions only.
    if (database)
      await database.db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
  });

  afterAll(async () => {
    integrationDatabase = undefined;
    await database?.pool.end();
  });

  function authenticateAs(currentUser: User, deviceSessionId?: string) {
    jest.mocked(getUserFromAuth).mockResolvedValue({
      user: currentUser,
      deviceSessionId,
      authFailedResponse: null,
    });
  }

  function registerClient(
    kind: 'browser' | 'mobile' = 'browser',
    supportedTools = registration.supportedTools
  ) {
    return applyHarnessClientCommand({
      ...registration,
      commandId: crypto.randomUUID(),
      clientId: registeredClientId,
      kind,
      supportedTools,
    });
  }

  function revokeClient() {
    return applyHarnessClientCommand({
      type: 'revokeClient',
      protocolVersion: 1,
      commandId: crypto.randomUUID(),
      clientId: registeredClientId,
    });
  }

  function storedClient() {
    return database.db
      .select()
      .from(agent_harness_clients)
      .where(eq(agent_harness_clients.id, registeredClientId));
  }

  type ClientResult = Awaited<ReturnType<typeof applyHarnessClientCommand>>;
  async function raceClientCommands(
    first: () => Promise<ClientResult>,
    second: () => Promise<ClientResult>
  ) {
    const transaction = database.db.transaction.bind(database.db);
    let competing: Promise<PromiseSettledResult<ClientResult>[]> | undefined;
    let canonical: (typeof agent_harness_clients.$inferSelect)[] | undefined;
    // Run the actual transaction callback and SQL, but hold its commit until the second upsert blocks.
    const held = jest.spyOn(database.db, 'transaction').mockImplementationOnce(work =>
      transaction(async tx => {
        const result = await work(tx);
        canonical = await tx
          .select()
          .from(agent_harness_clients)
          .where(eq(agent_harness_clients.id, registeredClientId));
        expect(canonical).toHaveLength(1);
        const { rows: sessions } = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`
        );
        competing = Promise.allSettled([second()]);
        const deadline = Date.now() + 5_000;
        let blocked = false;
        while (!blocked && Date.now() < deadline) {
          const { rows } = await database.pool.query<{ blocked: boolean }>(
            `SELECT EXISTS (
              SELECT 1 FROM pg_locks
              WHERE locktype = 'transactionid' AND NOT granted
                AND $1::integer = ANY(pg_blocking_pids(pid))
            ) AS blocked`,
            [sessions[0].pid]
          );
          blocked = rows[0].blocked;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        // The observed lock, not the polling delay, determines the commit order.
        expect(blocked).toBe(true);
        return result;
      })
    );
    try {
      const firstResult = await first();
      if (!competing || !canonical) throw new Error('The competing command did not start');
      const [secondResult] = await competing;
      return { firstResult, secondResult, canonical };
    } finally {
      held.mockRestore();
      // The real transaction commits or rolls back before cleanup waits for the blocked command.
      await competing;
    }
  }

  it.each(['registration', 'revocation'] as const)(
    'keeps the canonical client revoked when %s commits first',
    async first => {
      const { sessionBinding } = await authenticateHarnessIdentity();
      const { firstResult, secondResult, canonical } = await raceClientCommands(
        first === 'registration' ? () => registerClient() : revokeClient,
        first === 'registration' ? revokeClient : () => registerClient()
      );
      expect(firstResult).toMatchObject({
        id: registeredClientId,
        ownerUserId: owner.id,
        revokedAt: first === 'registration' ? null : expect.any(String),
      });
      expect(secondResult).toMatchObject(
        first === 'registration'
          ? {
              status: 'fulfilled',
              value: { id: registeredClientId, revokedAt: expect.any(String) },
            }
          : { status: 'rejected', reason: denied }
      );
      const revoked = await storedClient();
      expect(revoked).toEqual([{ ...canonical[0], revoked_at: expect.any(String) }]);
      expect(revoked[0]).toMatchObject({
        id: registeredClientId,
        user_id: owner.id,
        session_binding: sessionBinding,
        kind: 'browser',
        supported_tools: first === 'registration' ? registration.supportedTools : [],
      });
      await expect(
        requireHarnessClient(owner.id, registeredClientId, sessionBinding, database.db)
      ).rejects.toMatchObject(denied);
      await expect(
        registerClient('browser', first === 'registration' ? [] : registration.supportedTools)
      ).rejects.toMatchObject(denied);
      await revokeClient();
      expect(await storedClient()).toEqual(revoked);
    },
    10_000
  );

  it.each(['owner', 'session'] as const)(
    'refuses a concurrent registration from a conflicting %s without rebinding',
    async conflict => {
      const ownerSessionId = crypto.randomUUID();
      const contenderSessionId = crypto.randomUUID();
      const contender = conflict === 'owner' ? otherOwner : owner;
      await database.db.insert(device_sessions).values([
        { id: ownerSessionId, kilo_user_id: owner.id },
        { id: contenderSessionId, kilo_user_id: contender.id },
      ]);
      authenticateAs(owner, ownerSessionId);
      const { sessionBinding } = await authenticateHarnessIdentity();
      const { firstResult, secondResult, canonical } = await raceClientCommands(
        () => registerClient('mobile'),
        () => {
          authenticateAs(contender, contenderSessionId);
          return registerClient('mobile', []);
        }
      );
      expect(firstResult).toMatchObject({
        id: registeredClientId,
        ownerUserId: owner.id,
        supportedTools: registration.supportedTools,
        revokedAt: null,
      });
      expect(secondResult).toMatchObject({ status: 'rejected', reason: denied });
      expect(await storedClient()).toEqual(canonical);
      authenticateAs(owner, ownerSessionId);
      expect(
        (await requireHarnessClient(owner.id, registeredClientId, sessionBinding, database.db))
          .client
      ).toEqual(firstResult);
      await revokeClient();
      const revoked = await storedClient();
      expect(revoked).toEqual([{ ...canonical[0], revoked_at: expect.any(String) }]);
      authenticateAs(contender, contenderSessionId);
      await expect(registerClient('mobile', [])).rejects.toMatchObject(denied);
      expect(await storedClient()).toEqual(revoked);
    },
    10_000
  );

  it('enforces the owner predicate independently of the stored session binding', async () => {
    await registerClient();
    // Bind the row to another owner while retaining the requester's session binding and kind.
    // Otherwise the session predicate also rejects an owner conflict and hides a missing owner check.
    const canonical = await database.db
      .update(agent_harness_clients)
      .set({ user_id: otherOwner.id })
      .where(eq(agent_harness_clients.id, registeredClientId))
      .returning();
    await expect(registerClient('browser', [])).rejects.toMatchObject(denied);
    await expect(revokeClient()).rejects.toMatchObject(denied);
    expect(await storedClient()).toEqual(canonical);
  });

  it('updates availability for the same owner and session without replacing the canonical row', async () => {
    await registerClient();
    const canonical = await storedClient();
    const { sessionBinding } = await authenticateHarnessIdentity();
    const updated = await registerClient('browser', []);
    expect(updated).toMatchObject({ id: registeredClientId, supportedTools: [], revokedAt: null });
    expect(await storedClient()).toEqual([{ ...canonical[0], supported_tools: [] }]);
    expect(
      (await requireHarnessClient(owner.id, registeredClientId, sessionBinding, database.db)).client
    ).toEqual(updated);
  });
});
