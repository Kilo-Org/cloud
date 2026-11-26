import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import {
  admin_action_audit_logs,
  passkey_credentials,
  session_step_up_proofs,
  type User,
} from '@kilocode/db/schema';
import { hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { defineTestUser, insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { resetAdminNetworkConfigForTest } from '@kilocode/web-shared/lib/admin/admin-network';
import {
  adminMutationsMissingAuditSpec,
  inputFieldTarget,
  recordAdminAction,
  recordAdminActions,
  setAdminActionSinkForTest,
  setAdminAuditFailureAction,
  setAdminAuditTarget,
  userActionTarget,
  type DiscoveredProcedure,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import {
  adminProcedure,
  baseProcedure,
  createCallerFactory,
  createTRPCRouter,
  type TRPCContext,
} from './init';

const userInput = z.object({ userId: z.string() });

const testRouter = createTRPCRouter({
  block: adminProcedure
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'user.unblock',
        target: inputFieldTarget('user', 'userId'),
      },
    })
    .input(userInput)
    .mutation(({ input }) => input.userId),
  blockWithHandlerTarget: adminProcedure
    .meta({ adminAudit: { kind: 'declarative', action: 'user.unblock' } })
    .input(userInput)
    .mutation(({ input }) => {
      setAdminAuditTarget(userActionTarget(`resolved-${input.userId}`));
      return 'ok';
    }),
  refuse: adminProcedure
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'user.unblock',
        target: inputFieldTarget('user', 'userId'),
      },
    })
    .input(userInput)
    .mutation(() => {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'someone@customer.test is already blocked',
      });
    }),
  blockById: adminProcedure
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'user.unblock',
        target: inputFieldTarget('user', 'userId'),
      },
    })
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(({ input }) => input.userId),
  guardedBlock: adminProcedure
    .use(() => {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Narrower permission required' });
    })
    .meta({
      adminAudit: {
        kind: 'declarative',
        action: 'user.unblock',
        target: inputFieldTarget('user', 'userId'),
      },
    })
    .input(userInput)
    .mutation(({ input }) => input.userId),
  setBlock: adminProcedure
    .meta({ adminAudit: { kind: 'handler', actions: ['user.block', 'user.unblock'] } })
    .input(z.object({ userId: z.string(), blocked: z.boolean() }))
    .mutation(({ input }) => {
      setAdminAuditTarget(userActionTarget(input.userId));
      setAdminAuditFailureAction(input.blocked ? 'user.block' : 'user.unblock');
      throw new TRPCError({ code: 'FORBIDDEN', message: 'User is being deleted' });
    }),
  bulkUnblock: adminProcedure
    .meta({ adminAudit: { kind: 'handler', actions: ['user.unblock'] } })
    .mutation(async ({ ctx }) => {
      await recordAdminActions(ctx, []);
      return 'ok';
    }),
  resetKey: adminProcedure
    .meta({ adminAudit: { kind: 'handler', actions: ['user.api_key.reset'] } })
    .input(userInput)
    .mutation(async ({ ctx, input }) => {
      await recordAdminAction(ctx, {
        action: 'user.api_key.reset',
        target: userActionTarget(input.userId),
        message: 'Reset API key',
      });
      return 'ok';
    }),
  forgetsToRecord: adminProcedure
    .meta({ adminAudit: { kind: 'handler', actions: ['user.api_key.reset'] } })
    .mutation(() => 'ok'),
  readOnly: adminProcedure
    .meta({ adminAudit: { kind: 'exempt', reason: 'mutation-typed read' } })
    .mutation(() => 'ok'),
  undeclared: adminProcedure.mutation(() => 'ok'),
  invalidSpec: adminProcedure
    .meta({ adminAudit: { kind: 'exempt', reason: ' ' } })
    .mutation(() => 'ok'),
  list: adminProcedure.query(() => 'ok'),
  userWrite: baseProcedure.mutation(() => 'ok'),
});
const createCaller = createCallerFactory(testRouter);

let admin: User;

// The admission re-reads the primary row and requires a browser session, so
// the admin exists in the database and the context names a session credential.
function adminCaller(overrides: Partial<TRPCContext> = {}) {
  const ctx: TRPCContext = {
    user: admin,
    authViaToken: false,
    tokenSource: null,
    credential: 'session',
    ip: '192.0.2.9',
    ...overrides,
  };
  return createCaller(ctx);
}

beforeEach(async () => {
  setAdminActionSinkForTest(() => {});
  admin = await insertTestUser({ is_admin: true, is_super_admin: false });
});

afterEach(async () => {
  setAdminActionSinkForTest(null);
  await cleanupDbForTest();
});

describe('admin audit middleware', () => {
  test('records one success row for a declarative mutation, with the target from its input', async () => {
    await expect(adminCaller().block({ userId: 'user-1' })).resolves.toBe('user-1');

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'user.unblock',
        outcome: 'success',
        actor_id: admin.id,
        target_type: 'user',
        target_id: 'user-1',
        message: 'block',
      }),
    ]);
  });

  test('prefers the target the handler set over the spec target', async () => {
    await adminCaller().blockWithHandlerTarget({ userId: 'user-1' });

    const [row] = await db.select().from(admin_action_audit_logs);
    expect(row).toMatchObject({ target_type: 'user', target_id: 'resolved-user-1' });
  });

  test('records a failure row with the error code, never the message, and rethrows the error', async () => {
    const result = adminCaller().refuse({ userId: 'user-1' });
    await expect(result).rejects.toBeInstanceOf(TRPCError);
    await expect(result).rejects.toMatchObject({ code: 'CONFLICT' });

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'user.unblock',
        outcome: 'failure',
        target_id: 'user-1',
        message: 'refuse failed',
        metadata: { errorCode: 'CONFLICT' },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('customer.test');
  });

  test('adds no row of its own when a handler mutation records its action', async () => {
    await adminCaller().resetKey({ userId: 'user-1' });

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows.map(row => [row.action, row.message])).toEqual([
      ['user.api_key.reset', 'Reset API key'],
    ]);
  });

  test('reports a handler mutation that succeeded without recording', async () => {
    await expect(adminCaller().forgetsToRecord()).rejects.toThrow(
      'Admin audit gap: forgetsToRecord succeeded without recording user.api_key.reset'
    );
  });

  test('records nothing for an exempt mutation or a query', async () => {
    await adminCaller().readOnly();
    await adminCaller().list();

    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
  });

  test('refuses an admin mutation without adminAudit meta in tests', async () => {
    await expect(adminCaller().undeclared()).rejects.toThrow(
      'Admin audit gap: undeclared declares no adminAudit meta'
    );
  });

  test('reports no audit gap for a non-admin, whom the admission refuses first', async () => {
    const nonAdmin = defineTestUser({ is_admin: false, is_super_admin: false });
    await expect(adminCaller({ user: nonAdmin }).undeclared()).rejects.toThrow(
      'Admin access required'
    );
  });

  test('records nothing for a revoked browser session', async () => {
    // The session is not current, so the request never names an acting admin.
    const pepperedAdmin = await insertTestUser({
      is_admin: true,
      is_super_admin: false,
      web_session_pepper: 'current-pepper',
    });
    await expect(
      adminCaller({ user: pepperedAdmin, webSessionPepper: 'revoked-pepper' }).block({
        userId: 'user-1',
      })
    ).rejects.toThrow('Reauthentication required');

    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
  });

  test('records nothing for a bearer credential', async () => {
    // A bearer credential never gets staff authority, so it never names an
    // acting admin either.
    await expect(
      adminCaller({ authViaToken: true, credential: 'human_bearer' }).block({ userId: 'user-1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
  });

  test('reports no audit gap for a bearer credential, which the admission refuses first', async () => {
    await expect(
      adminCaller({ authViaToken: true, credential: 'human_bearer' }).undeclared()
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('records nothing when the primary row is no longer an admin', async () => {
    const demoted = await insertTestUser({ is_admin: false, is_super_admin: false });
    await expect(
      adminCaller({ user: { ...demoted, is_admin: true } }).block({ userId: 'user-1' })
    ).rejects.toThrow('Admin access required');

    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
  });

  describe('with the admin network allowlist', () => {
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

    test('records nothing when the network refuses an admin', async () => {
      await expect(
        adminCaller({
          headersList: new Headers({ 'x-vercel-forwarded-for': '198.51.100.1' }),
        }).block({ userId: 'user-1' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
    });
  });

  test('reports a handler mutation that recorded an empty list', async () => {
    await expect(adminCaller().bulkUnblock()).rejects.toThrow(
      'Admin audit gap: bulkUnblock succeeded without recording user.unblock'
    );
  });

  test('records the failure under the action the handler named', async () => {
    await expect(adminCaller().setBlock({ userId: 'user-1', blocked: false })).rejects.toThrow(
      'User is being deleted'
    );

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'user.unblock',
        outcome: 'failure',
        target_id: 'user-1',
        metadata: { errorCode: 'FORBIDDEN' },
      }),
    ]);
  });

  test('records input that never parsed as a failure with no target', async () => {
    await expect(adminCaller().blockById({ userId: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'user.unblock',
        outcome: 'failure',
        target_type: null,
        target_id: null,
        metadata: { errorCode: 'BAD_REQUEST' },
      }),
    ]);
  });

  test('records a narrower guard refusal before parsing with no target', async () => {
    await expect(
      adminCaller().guardedBlock({ userId: 'someone@customer.test' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'user.unblock',
        outcome: 'failure',
        target_type: null,
        target_id: null,
        metadata: { errorCode: 'FORBIDDEN' },
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain('customer.test');
  });

  describe('with step-up enforced', () => {
    const originalSwitch = process.env.ADMIN_STEP_UP_ENABLED;
    beforeEach(() => {
      process.env.ADMIN_STEP_UP_ENABLED = 'true';
    });
    afterEach(() => {
      process.env.ADMIN_STEP_UP_ENABLED = originalSwitch;
    });

    const webSessionId = 'admin-audit-session';

    async function insertSessionProof(userId: string) {
      const [credential] = await db
        .insert(passkey_credentials)
        .values({
          kilo_user_id: userId,
          credential_id: `admin-audit-${crypto.randomUUID()}`,
          public_key: 'unused-public-key',
        })
        .returning();
      await db.insert(session_step_up_proofs).values({
        kilo_user_id: userId,
        session_id_hash: hashWebSessionId(webSessionId),
        method: 'webauthn_uv',
        passkey_credential_id: credential!.id,
        purpose: 'session',
        action_binding_hash: null,
        verified_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
    }

    test('records a current staff session refused for a missing proof as a failure row with no target, since input never parsed', async () => {
      const result = adminCaller({ webSessionId }).block({ userId: 'someone@customer.test' });
      await expect(result).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const rows = await db.select().from(admin_action_audit_logs);
      expect(rows).toEqual([
        expect.objectContaining({
          action: 'user.unblock',
          outcome: 'failure',
          actor_id: admin.id,
          target_type: null,
          target_id: null,
          metadata: { errorCode: 'FORBIDDEN' },
        }),
      ]);
      expect(JSON.stringify(rows)).not.toContain('customer.test');
    });

    test('records one success row once the admission accepted the proof and the resolver returned', async () => {
      await insertSessionProof(admin.id);

      await expect(adminCaller({ webSessionId }).block({ userId: 'user-1' })).resolves.toBe(
        'user-1'
      );

      const rows = await db.select().from(admin_action_audit_logs);
      expect(rows).toEqual([
        expect.objectContaining({
          action: 'user.unblock',
          outcome: 'success',
          actor_id: admin.id,
          target_type: 'user',
          target_id: 'user-1',
        }),
      ]);
    });

    test('records a narrower guard refusal after an accepted proof as a failure row', async () => {
      await insertSessionProof(admin.id);

      await expect(
        adminCaller({ webSessionId }).guardedBlock({ userId: 'user-1' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const rows = await db.select().from(admin_action_audit_logs);
      expect(rows).toEqual([
        expect.objectContaining({
          action: 'user.unblock',
          outcome: 'failure',
          actor_id: admin.id,
          metadata: { errorCode: 'FORBIDDEN' },
        }),
      ]);
    });

    test('records nothing when the admin guard refuses a non-admin', async () => {
      const nonAdmin = defineTestUser({ is_admin: false, is_super_admin: false });
      await expect(adminCaller({ user: nonAdmin }).block({ userId: 'user-1' })).rejects.toThrow(
        'Admin access required'
      );

      expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
    });
  });
});

describe('adminMutationsMissingAuditSpec', () => {
  test('lists admin mutations without a valid spec, ignoring queries and non-admin mutations', () => {
    const procedures = testRouter._def.procedures as Record<string, DiscoveredProcedure>;

    expect(adminMutationsMissingAuditSpec(procedures)).toEqual(['invalidSpec', 'undeclared']);
  });
});
