import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import {
  adminProcedure,
  baseProcedure,
  createCallerFactory,
  createTRPCRouter,
  type TRPCContext,
} from './init';
import {
  recordKiloAdminElevation,
  setAdminAccessSinkForTest,
  UNSCOPED_TARGET,
  type AdminAccessEvent,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import { resetAdminNetworkConfigForTest } from '@kilocode/web-shared/lib/admin/admin-network';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

const testRouter = createTRPCRouter({
  ping: adminProcedure.query(() => 'ok'),
  chainedDenial: adminProcedure
    .use(async () => {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Specialized guard denied' });
    })
    .query(() => 'unreachable'),
  // Stands in for the `is_admin` bypasses on regular procedures, which can only
  // name their procedure if `baseProcedure` publishes it onto the context.
  bypass: baseProcedure.mutation(async ({ ctx }) => {
    await recordKiloAdminElevation(ctx, {
      reason: 'cli_session_cross_org_query',
      target: UNSCOPED_TARGET,
    });
    return 'ok';
  }),
});
const createCaller = createCallerFactory(testRouter);

function ctxFor(overrides: Partial<TRPCContext> & Pick<TRPCContext, 'user'>): TRPCContext {
  return { authViaToken: false, tokenSource: null, ip: null, ...overrides };
}

let events: AdminAccessEvent[];

beforeEach(() => {
  events = [];
  setAdminAccessSinkForTest(event => events.push(event));
});

afterEach(() => {
  setAdminAccessSinkForTest(null);
});

describe('adminProcedure admin_access telemetry', () => {
  test('emits a trpc session event for a web-console admin', async () => {
    const caller = createCaller(
      ctxFor({ user: defineTestUser({ is_admin: true, is_super_admin: true }), ip: '9.9.9.9' })
    );

    await expect(caller.ping()).resolves.toBe('ok');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'admin_access',
      surface: 'trpc',
      kind: 'admin_guard',
      authVia: 'session',
      adminTier: 'super_admin',
      route: 'ping',
      method: 'query',
      ip: '9.9.9.9',
      tokenSource: null,
    });
  });

  test('emits authVia token when the caller authenticated via a bearer token', async () => {
    const caller = createCaller(
      ctxFor({
        user: defineTestUser({ is_admin: true, is_super_admin: false }),
        authViaToken: true,
        tokenSource: 'cloud-agent',
      })
    );

    await caller.ping();

    expect(events.map(event => event.kind)).toEqual(['admin_guard', 'privileged_access']);
    expect(events[0]).toMatchObject({
      surface: 'trpc',
      kind: 'admin_guard',
      authVia: 'token',
      adminTier: 'platform_admin',
      credential: 'delegated_workload',
      wouldBlock: true,
      tokenSource: 'cloud-agent',
    });
    expect(events[1]).toMatchObject({
      kind: 'privileged_access',
      credential: 'delegated_workload',
      outcome: 'succeeded',
      actionClass: 'platform_read',
    });
  });

  // Regression: a `{ user }`-shaped context that omits the derived `credential`
  // falls back to the same four-input derivation as the request boundary. A
  // delegated Cloud Agent authority must not be mislabeled as a human bearer.
  test('classifies a delegated authority in the credential fallback like the boundary does', async () => {
    const delegatedUser = defineTestUser({ is_admin: true, is_super_admin: false });
    const delegatedRouter = createTRPCRouter({
      models: createTRPCRouter({
        list: adminProcedure.query(() => 'ok'),
      }),
    });
    const caller = createCallerFactory(delegatedRouter)(
      ctxFor({
        user: delegatedUser,
        authViaToken: true,
        tokenSource: null,
        cloudAgentAuthority: {
          version: 1,
          ownerId: delegatedUser.id,
          parentSessionId: 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          organizationId: null,
          authorizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        } as unknown as CloudAgentAuthority,
      })
    );

    await caller.models.list();

    expect(events[0]).toMatchObject({
      kind: 'admin_guard',
      credential: 'delegated_workload',
      wouldBlock: true,
    });
  });

  test('emits denied, not succeeded, when a chained guard refuses the request', async () => {
    const caller = createCaller(
      ctxFor({
        user: defineTestUser({ is_admin: true, is_super_admin: false }),
        authViaToken: true,
      })
    );

    await expect(caller.chainedDenial()).rejects.toThrow();

    expect(events.map(event => event.kind)).toEqual(['admin_guard', 'privileged_access']);
    expect(events[1]).toMatchObject({
      kind: 'privileged_access',
      credential: 'human_bearer',
      outcome: 'denied',
      wouldBlock: true,
    });
  });

  test('emits a denied privileged_access event for a non-admin bearer caller', async () => {
    const user = defineTestUser({ is_admin: false });
    const caller = createCaller(ctxFor({ user, authViaToken: true }));

    await expect(caller.ping()).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'privileged_access',
      credential: 'human_bearer',
      outcome: 'denied',
      actionClass: 'platform_read',
      // A resolved non-admin is attributable to its account, but carries no
      // tier: the denial itself is the finding.
      kiloUserId: user.id,
      email: user.google_user_email,
      adminTier: null,
      wouldBlock: true,
    });
  });

  test('does not emit for a non-admin caller', async () => {
    const caller = createCaller(ctxFor({ user: defineTestUser({ is_admin: false }) }));

    await expect(caller.ping()).rejects.toThrow();

    expect(events).toHaveLength(0);
  });
});

describe('adminProcedure admin network allowlist', () => {
  const originalVercel = process.env.VERCEL;
  const originalNetworks = process.env.ADMIN_ALLOWED_NETWORKS;

  beforeEach(() => {
    process.env.VERCEL = '1';
    process.env.ADMIN_ALLOWED_NETWORKS = '203.0.113.0/24';
    resetAdminNetworkConfigForTest();
  });

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
    if (originalNetworks === undefined) delete process.env.ADMIN_ALLOWED_NETWORKS;
    else process.env.ADMIN_ALLOWED_NETWORKS = originalNetworks;
    resetAdminNetworkConfigForTest();
  });

  function adminCallerFrom(headersList: Headers) {
    return createCaller(ctxFor({ user: defineTestUser({ is_admin: true }), headersList }));
  }

  test('refuses an admin outside the allowlist on Vercel with FORBIDDEN', async () => {
    const caller = adminCallerFrom(
      new Headers({ 'x-vercel-forwarded-for': '198.51.100.1', 'x-forwarded-for': '203.0.113.7' })
    );

    const error = await caller.ping().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('WARP') });
    expect(events).toHaveLength(0);
  });

  test('lets an admin inside the allowlist through', async () => {
    const caller = adminCallerFrom(new Headers({ 'x-vercel-forwarded-for': '203.0.113.7' }));

    await expect(caller.ping()).resolves.toBe('ok');
  });

  test('emits one denied privileged_access event for a bearer admin refused by the network', async () => {
    const caller = createCaller(
      ctxFor({
        user: defineTestUser({ is_admin: true }),
        authViaToken: true,
        ip: '192.0.2.9',
        headersList: new Headers({
          'x-vercel-forwarded-for': '198.51.100.1',
          'x-forwarded-for': '192.0.2.9',
        }),
      })
    );

    await expect(caller.ping()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'privileged_access',
      outcome: 'denied',
      ip: '198.51.100.1',
    });
  });

  test('records a null address, not ctx.ip, when the trusted header is missing', async () => {
    // `ctx.ip` falls back to the client-settable x-forwarded-for.
    const caller = createCaller(
      ctxFor({
        user: defineTestUser({ is_admin: true }),
        authViaToken: true,
        ip: '203.0.113.7',
        headersList: new Headers({ 'x-forwarded-for': '203.0.113.7' }),
      })
    );

    await expect(caller.ping()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'privileged_access', outcome: 'denied', ip: null });
  });

  test('keeps the non-admin refusal for a non-admin outside the allowlist', async () => {
    const caller = createCaller(
      ctxFor({
        user: defineTestUser({ is_admin: false }),
        headersList: new Headers({ 'x-vercel-forwarded-for': '198.51.100.1' }),
      })
    );

    await expect(caller.ping()).rejects.toMatchObject({ message: 'Admin access required' });
  });
});

describe('baseProcedure audit context', () => {
  test('publishes the procedure path and type so elevations inside a resolver are attributable', async () => {
    const caller = createCaller(
      ctxFor({ user: defineTestUser({ is_admin: true }), ip: '203.0.113.7' })
    );

    await expect(caller.bypass()).resolves.toBe('ok');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: 'trpc',
      kind: 'kilo_admin_elevation',
      route: 'bypass',
      method: 'mutation',
      ip: '203.0.113.7',
      reason: 'cli_session_cross_org_query',
      target: '*',
    });
  });
});

describe('cloudAgentAuthorityMiddleware exact procedure allowlist', () => {
  const parentSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const childSessionId = 'workspace_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const messageId = 'msg_123456789abc123456789ABCDE';
  const user = defineTestUser({ id: 'oauth/scoped-middleware-owner' });
  const authority: CloudAgentAuthority = {
    version: 1,
    ownerId: user.id,
    parentSessionId,
    organizationId: null,
    authorizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };

  const promptPayload = {
    type: 'prompt' as const,
    prompt: 'bounded child task',
    mode: 'code',
    model: 'kilo/test-model',
  };
  const getMessageResultInput = {
    cloudAgentSessionId: childSessionId,
    messageId,
  };

  const scopedRouter = createTRPCRouter({
    cloudAgentNext: createTRPCRouter({
      getSession: baseProcedure
        .input(z.object({ cloudAgentSessionId: z.string() }).strict())
        .query(({ input }) => input),
      getMessageResult: baseProcedure
        .input(
          z
            .object({
              cloudAgentSessionId: z.string(),
              messageId: z.string(),
              expectedWorktreeId: z.string().optional(),
            })
            .strict()
        )
        .query(({ input }) => input),
      listChildSessions: baseProcedure
        .input(
          z
            .object({
              limit: z.number().int().min(1).max(50).optional(),
              cursor: z.uuid().optional(),
            })
            .strict()
        )
        .query(({ input }) => input),
      sendMessage: baseProcedure
        .input(
          z
            .object({
              cloudAgentSessionId: z.string(),
              messageId: z.string(),
              payload: z.discriminatedUnion('type', [
                z
                  .object({
                    type: z.literal('prompt'),
                    prompt: z.string(),
                    mode: z.string(),
                    model: z.string(),
                    variant: z.string().optional(),
                  })
                  .strict(),
                z
                  .object({
                    type: z.literal('command'),
                    command: z.string(),
                    arguments: z.string(),
                  })
                  .strict(),
              ]),
              autoCommit: z.boolean().optional(),
              expectedWorktreeId: z.string().optional(),
            })
            .strict()
        )
        .mutation(({ input }) => input),
      interruptSession: baseProcedure
        .input(z.object({ sessionId: z.string() }).strict())
        .mutation(({ input }) => input),
    }),
    models: createTRPCRouter({
      list: baseProcedure.query(() => 'models'),
    }),
    organizations: createTRPCRouter({
      cloudAgentNext: createTRPCRouter({
        getSession: baseProcedure
          .input(z.object({ cloudAgentSessionId: z.string(), organizationId: z.string() }).strict())
          .query(({ input }) => input),
        listChildSessions: baseProcedure
          .input(
            z
              .object({
                limit: z.number().int().min(1).max(50).optional(),
                cursor: z.uuid().optional(),
                organizationId: z.string(),
              })
              .strict()
          )
          .query(({ input }) => input),
      }),
    }),
  });

  const wrongKindRouter = createTRPCRouter({
    cloudAgentNext: createTRPCRouter({
      getSession: baseProcedure
        .input(z.object({ cloudAgentSessionId: z.string() }).strict())
        .mutation(({ input }) => input),
    }),
    models: createTRPCRouter({
      list: baseProcedure.mutation(() => 'models'),
    }),
  });

  const outsideAllowlistRouter = createTRPCRouter({
    models: createTRPCRouter({
      preferred: baseProcedure.query(() => 'preferred'),
    }),
    user: createTRPCRouter({
      getMe: baseProcedure.query(() => 'me'),
    }),
  });

  const scopedCaller = createCallerFactory(scopedRouter);
  const wrongKindCaller = createCallerFactory(wrongKindRouter);
  const outsideCaller = createCallerFactory(outsideAllowlistRouter);
  const context = (scope: CloudAgentAuthority | undefined) =>
    ctxFor({ user, cloudAgentAuthority: scope });

  test('allows the exact query and mutation procedures with matching kinds', async () => {
    const caller = scopedCaller(context(authority));
    await expect(
      caller.cloudAgentNext.getSession({ cloudAgentSessionId: childSessionId })
    ).resolves.toEqual({ cloudAgentSessionId: childSessionId });
    await expect(caller.cloudAgentNext.getMessageResult(getMessageResultInput)).resolves.toEqual(
      getMessageResultInput
    );
    await expect(caller.cloudAgentNext.listChildSessions({ limit: 5 })).resolves.toEqual({
      limit: 5,
    });
    await expect(
      caller.cloudAgentNext.sendMessage({
        cloudAgentSessionId: childSessionId,
        messageId,
        payload: promptPayload,
      })
    ).resolves.toMatchObject({ payload: promptPayload });
    await expect(
      caller.cloudAgentNext.interruptSession({ sessionId: childSessionId })
    ).resolves.toEqual({ sessionId: childSessionId });
    await expect(caller.models.list()).resolves.toBe('models');
  });

  test('allows only strict empty models.list discovery for both scopes', async () => {
    const personal = scopedCaller(context(authority));
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const organization = scopedCaller(context({ ...authority, organizationId }));

    await expect(personal.models.list()).resolves.toBe('models');
    await expect(organization.models.list()).resolves.toBe('models');
    await expect((personal.models.list as (input: unknown) => Promise<unknown>)({})).resolves.toBe(
      'models'
    );
    for (const caller of [personal, organization]) {
      for (const input of [{ organizationId }, { extra: true }, null]) {
        await expect(
          (caller.models.list as (input: unknown) => Promise<unknown>)(input)
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    }
  });

  test('denies other models procedures even when the name is adjacent', async () => {
    await expect(outsideCaller(context(authority)).models.preferred()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('denies a procedure whose registered kind does not match the authority kind', async () => {
    await expect(
      wrongKindCaller(context(authority)).cloudAgentNext.getSession({
        cloudAgentSessionId: childSessionId,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(wrongKindCaller(context(authority)).models.list()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('denies procedures outside the authority allowlist', async () => {
    await expect(outsideCaller(context(authority)).user.getMe()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('denies a scoped command payload that the prompt-only schema rejects', async () => {
    await expect(
      scopedCaller(context(authority)).cloudAgentNext.sendMessage({
        cloudAgentSessionId: childSessionId,
        messageId,
        payload: { type: 'command', command: 'review', arguments: '' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('pins organization procedures to the signed organization', async () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const orgAuthority: CloudAgentAuthority = { ...authority, organizationId };
    const orgCaller = scopedCaller(context(orgAuthority));

    await expect(
      orgCaller.organizations.cloudAgentNext.getSession({
        cloudAgentSessionId: childSessionId,
        organizationId,
      })
    ).resolves.toEqual({ cloudAgentSessionId: childSessionId, organizationId });
    await expect(
      scopedCaller(context(authority)).organizations.cloudAgentNext.getSession({
        cloudAgentSessionId: childSessionId,
        organizationId,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      orgCaller.organizations.cloudAgentNext.getSession({
        cloudAgentSessionId: childSessionId,
        organizationId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
