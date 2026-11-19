jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/admin/step-up-store');
  return { ...actual, evaluateStepUp: jest.fn(actual.evaluateStepUp) };
});

import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { kilocode_users, passkey_credentials, session_step_up_proofs } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  StepUpRequiredError,
  type StepUpOperationBinding,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import {
  hashStepUpBinding,
  hashWebSessionId,
  revokeStepUpProofs,
} from '@kilocode/web-shared/lib/admin/step-up-store';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createBearerCallerForUser, createSessionCallerForUser } from '@/routers/test-utils';
import { assertPrivilegedPermission, requirePrivilegedActor } from './require-privileged-actor';

const webSessionId = 'guard-web-session';
const originalSwitch = process.env.ADMIN_STEP_UP_ENABLED;

async function adminUser(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({ is_admin: true, ...overrides });
}

async function insertPasskey(userId: string) {
  const [credential] = await db
    .insert(passkey_credentials)
    .values({
      kilo_user_id: userId,
      credential_id: `guard-credential-${crypto.randomUUID()}`,
      public_key: 'unused-public-key',
    })
    .returning();
  return credential!;
}

async function insertProof(
  userId: string,
  credentialUuid: string,
  params: {
    sessionId?: string;
    verifiedAt?: Date;
    expiresAt?: Date;
    revokedAt?: Date | null;
  } = {}
) {
  const verifiedAt = params.verifiedAt ?? new Date();
  const [proof] = await db
    .insert(session_step_up_proofs)
    .values({
      kilo_user_id: userId,
      session_id_hash: hashWebSessionId(params.sessionId ?? webSessionId),
      method: 'webauthn_uv',
      passkey_credential_id: credentialUuid,
      purpose: 'session',
      verified_at: verifiedAt.toISOString(),
      expires_at: (params.expiresAt ?? new Date(verifiedAt.getTime() + 15 * 60_000)).toISOString(),
      revoked_at: params.revokedAt ? params.revokedAt.toISOString() : null,
      revoked_reason: params.revokedAt ? 'test' : null,
    })
    .returning();
  return proof!;
}

/**
 * A proof minted for one operation: the stored binding is the same hash the
 * guard computes from its own request.
 */
async function insertOperationProof(
  userId: string,
  credentialUuid: string,
  binding: StepUpOperationBinding
) {
  const verifiedAt = new Date();
  const [proof] = await db
    .insert(session_step_up_proofs)
    .values({
      kilo_user_id: userId,
      session_id_hash: hashWebSessionId(webSessionId),
      method: 'webauthn_uv',
      passkey_credential_id: credentialUuid,
      purpose: 'operation',
      action_binding_hash: hashStepUpBinding(binding.actionClass, {
        surface: binding.surface,
        route: binding.route,
        method: binding.method,
        target: { kind: binding.targetKind, id: binding.targetId },
      }),
      verified_at: verifiedAt.toISOString(),
      expires_at: new Date(verifiedAt.getTime() + 5 * 60_000).toISOString(),
    })
    .returning();
  return proof!;
}

function contextFor(user: Awaited<ReturnType<typeof adminUser>>) {
  return {
    user,
    credential: 'session' as const,
    webSessionId,
    webSessionPepper: user.web_session_pepper,
    headersList: new Headers(),
    trpcPath: 'admin.test',
    trpcType: 'query',
  };
}

function freshUpstreamState() {
  return {
    status: 'fresh' as const,
    method: 'webauthn_uv' as const,
    verifiedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function causeOf(error: unknown): StepUpRequiredError | null {
  return error instanceof TRPCError && error.cause instanceof StepUpRequiredError
    ? error.cause
    : null;
}

async function refusal(promise: Promise<unknown>): Promise<StepUpRequiredError | null> {
  const error = await promise.then(
    () => null,
    (rejection: unknown) => rejection
  );
  if (!(error instanceof TRPCError)) return null;
  return error.cause instanceof StepUpRequiredError ? error.cause : null;
}

describe('requirePrivilegedActor', () => {
  const createdUserIds: string[] = [];

  async function setup() {
    const user = await adminUser();
    createdUserIds.push(user.id);
    const credential = await insertPasskey(user.id);
    return { user, credential };
  }

  beforeEach(() => {
    process.env.ADMIN_STEP_UP_ENABLED = 'false';
  });

  afterEach(async () => {
    process.env.ADMIN_STEP_UP_ENABLED = originalSwitch;
    for (const userId of createdUserIds.splice(0)) {
      await db
        .delete(session_step_up_proofs)
        .where(eq(session_step_up_proofs.kilo_user_id, userId));
      await db.delete(passkey_credentials).where(eq(passkey_credentials.kilo_user_id, userId));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
  });

  describe('switch off', () => {
    it('does not deny a session without a proof', async () => {
      const { user } = await setup();

      const actor = await requirePrivilegedActor(
        { permission: 'admin', actionClass: 'platform_read' },
        contextFor(user)
      );

      expect(actor.assurance.stepUp).toEqual({ status: 'absent' });
    });

    it('does not deny a bearer credential', async () => {
      const { user } = await setup();

      const actor = await requirePrivilegedActor(
        { permission: 'admin', actionClass: 'platform_read' },
        { ...contextFor(user), credential: 'human_bearer', authViaToken: true }
      );

      expect(actor.assurance.stepUp).toEqual({ status: 'absent' });
    });

    it('leaves an admin procedure working without a proof or evaluation', async () => {
      const { user } = await setup();
      const { evaluateStepUp } = jest.requireMock(
        '@kilocode/web-shared/lib/admin/step-up-store'
      ) as { evaluateStepUp: jest.Mock };
      evaluateStepUp.mockClear();
      const caller = await createSessionCallerForUser(user.id);

      await expect(caller.admin.getPermissions()).resolves.toBeDefined();
      expect(evaluateStepUp).not.toHaveBeenCalled();
    });
  });

  describe('switch on', () => {
    beforeEach(() => {
      process.env.ADMIN_STEP_UP_ENABLED = 'true';
    });

    it('denies a session without a proof', async () => {
      const { user } = await setup();

      const cause = await refusal(
        requirePrivilegedActor(
          { permission: 'admin', actionClass: 'platform_read' },
          contextFor(user)
        )
      );

      expect(cause?.code).toBe('MFA_REQUIRED');
    });

    it('allows a fresh proof for this session', async () => {
      const { user, credential } = await setup();
      await insertProof(user.id, credential.id);

      const actor = await requirePrivilegedActor(
        { permission: 'admin', actionClass: 'platform_read' },
        contextFor(user)
      );

      expect(actor.assurance.stepUp.status).toBe('fresh');
    });

    it('does not accept a proof minted for another session', async () => {
      const { user, credential } = await setup();
      await insertProof(user.id, credential.id, { sessionId: 'another-session' });

      const cause = await refusal(
        requirePrivilegedActor(
          { permission: 'admin', actionClass: 'platform_read' },
          contextFor(user)
        )
      );

      expect(cause?.code).toBe('MFA_REQUIRED');
    });

    it('reports an expired proof as MFA_EXPIRED', async () => {
      const { user, credential } = await setup();
      const verifiedAt = new Date(Date.now() - 20 * 60_000);
      await insertProof(user.id, credential.id, {
        verifiedAt,
        expiresAt: new Date(verifiedAt.getTime() + 15 * 60_000),
      });

      const cause = await refusal(
        requirePrivilegedActor(
          { permission: 'admin', actionClass: 'platform_read' },
          contextFor(user)
        )
      );

      expect(cause?.code).toBe('MFA_EXPIRED');
    });

    it('reports a revoked proof as MFA_EXPIRED', async () => {
      const { user, credential } = await setup();
      await insertProof(user.id, credential.id, { revokedAt: new Date() });

      const cause = await refusal(
        requirePrivilegedActor(
          { permission: 'admin', actionClass: 'platform_read' },
          contextFor(user)
        )
      );

      expect(cause?.code).toBe('MFA_EXPIRED');
    });

    it('denies the next request after a proof is revoked', async () => {
      const { user, credential } = await setup();
      await insertProof(user.id, credential.id);
      await revokeStepUpProofs(user.id, 'test_revocation');

      const cause = await refusal(
        requirePrivilegedActor(
          { permission: 'admin', actionClass: 'platform_read' },
          contextFor(user)
        )
      );

      expect(cause?.code).toBe('MFA_EXPIRED');
    });

    it('denies a bearer credential', async () => {
      const { user } = await setup();

      const cause = await refusal(
        requirePrivilegedActor(
          { permission: 'admin', actionClass: 'platform_read' },
          { ...contextFor(user), credential: 'human_bearer', authViaToken: true }
        )
      );

      expect(cause?.code).toBe('BEARER_NOT_ALLOWED');
    });

    it('fails closed when the evaluation errors', async () => {
      const { user } = await setup();
      const { evaluateStepUp } = jest.requireMock(
        '@kilocode/web-shared/lib/admin/step-up-store'
      ) as { evaluateStepUp: jest.Mock };
      evaluateStepUp.mockRejectedValueOnce(new Error('relation does not exist'));

      const cause = await refusal(
        requirePrivilegedActor(
          { permission: 'admin', actionClass: 'platform_read' },
          contextFor(user)
        )
      );

      expect(cause?.code).toBe('STEP_UP_UNAVAILABLE');
    });

    it('refuses a session proof for a sensitive write', async () => {
      const { user, credential } = await setup();
      await insertProof(user.id, credential.id);

      const cause = await refusal(
        requirePrivilegedActor(
          {
            permission: 'admin',
            actionClass: 'sensitive_write',
            inventoryId: 'trpc.admin.users',
            target: { kind: 'user', id: 'target-user' },
          },
          contextFor(user)
        )
      );

      // A session proof never authorizes an operation class, even when fresh.
      expect(cause).toMatchObject({
        code: 'MFA_REQUIRED',
        actionClass: 'sensitive_write',
        purpose: 'operation',
        maxAgeSeconds: 300,
        binding: {
          actionClass: 'sensitive_write',
          route: 'admin.test',
          method: 'query',
          targetKind: 'user',
          targetId: 'target-user',
        },
      });
    });

    it('accepts an operation proof bound to this action and target once', async () => {
      const { user, credential } = await setup();
      await insertOperationProof(user.id, credential.id, {
        actionClass: 'sensitive_write',
        surface: 'trpc',
        route: 'admin.test',
        method: 'query',
        targetKind: 'user',
        targetId: 'target-user',
      });

      const params = {
        permission: 'admin' as const,
        actionClass: 'sensitive_write' as const,
        inventoryId: 'trpc.admin.users',
        target: { kind: 'user' as const, id: 'target-user' },
      };

      const actor = await requirePrivilegedActor(params, contextFor(user));
      expect(actor.assurance.stepUp.status).toBe('fresh');

      const reused = await refusal(requirePrivilegedActor(params, contextFor(user)));
      expect(reused?.code).toBe('MFA_REQUIRED');
    });

    it('refuses an operation proof minted for another target', async () => {
      const { user, credential } = await setup();
      await insertOperationProof(user.id, credential.id, {
        actionClass: 'sensitive_write',
        surface: 'trpc',
        route: 'admin.test',
        method: 'query',
        targetKind: 'user',
        targetId: 'another-user',
      });

      const cause = await refusal(
        requirePrivilegedActor(
          {
            permission: 'admin',
            actionClass: 'sensitive_write',
            target: { kind: 'user', id: 'target-user' },
          },
          contextFor(user)
        )
      );

      expect(cause?.code).toBe('MFA_REQUIRED');
    });

    it('reuses the state measured by the admin middleware', async () => {
      const { user } = await setup();

      const actor = await requirePrivilegedActor(
        { permission: 'admin', actionClass: 'platform_read' },
        {
          ...contextFor(user),
          adminStepUpState: freshUpstreamState(),
          adminStepUpDecision: {
            actionClass: 'platform_read',
            target: { kind: 'none', id: null },
          },
        }
      );

      expect(actor.assurance.stepUp.status).toBe('fresh');
    });

    it('reuses a fresh decision that covers the requested operation and target', async () => {
      const { user } = await setup();
      const { evaluateStepUp } = jest.requireMock(
        '@kilocode/web-shared/lib/admin/step-up-store'
      ) as { evaluateStepUp: jest.Mock };
      evaluateStepUp.mockClear();

      const actor = await requirePrivilegedActor(
        {
          permission: 'admin',
          actionClass: 'sensitive_write',
          target: { kind: 'user', id: 'target-user' },
        },
        {
          ...contextFor(user),
          adminStepUpState: freshUpstreamState(),
          adminStepUpDecision: {
            actionClass: 'sensitive_write',
            target: { kind: 'user', id: 'target-user' },
          },
        }
      );

      expect(actor.assurance.stepUp.status).toBe('fresh');
      expect(evaluateStepUp).not.toHaveBeenCalled();
    });

    it('reuses an operation decision when the caller names no target', async () => {
      const { user } = await setup();
      const { evaluateStepUp } = jest.requireMock(
        '@kilocode/web-shared/lib/admin/step-up-store'
      ) as { evaluateStepUp: jest.Mock };
      evaluateStepUp.mockClear();

      const actor = await requirePrivilegedActor(
        { permission: 'admin', actionClass: 'sensitive_write' },
        {
          ...contextFor(user),
          adminStepUpState: freshUpstreamState(),
          adminStepUpDecision: {
            actionClass: 'sensitive_write',
            target: { kind: 'none', id: null },
          },
        }
      );

      expect(actor.assurance.stepUp.status).toBe('fresh');
      expect(evaluateStepUp).not.toHaveBeenCalled();
    });

    it('reuses a decision bound to a target when the caller names none', async () => {
      const { user } = await setup();

      const actor = await requirePrivilegedActor(
        { permission: 'admin', actionClass: 'sensitive_write' },
        {
          ...contextFor(user),
          adminStepUpState: freshUpstreamState(),
          adminStepUpDecision: {
            actionClass: 'sensitive_write',
            target: { kind: 'user', id: 'target-user' },
          },
        }
      );

      expect(actor.assurance.stepUp.status).toBe('fresh');
    });

    it('refuses a fresh decision that does not name the requested target', async () => {
      const { user } = await setup();

      // A decision without a target id covers a request that names none, so
      // this request needs its own decision.
      await expect(
        requirePrivilegedActor(
          {
            permission: 'admin',
            actionClass: 'sensitive_write',
            target: { kind: 'user', id: 'target-user' },
          },
          {
            ...contextFor(user),
            adminStepUpState: freshUpstreamState(),
            adminStepUpDecision: {
              actionClass: 'sensitive_write',
              target: { kind: 'user', id: null },
            },
          }
        )
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'This request was verified for a different operation',
      });
    });

    it('binds an operation proof to the user id the request input names', async () => {
      const { user: admin, credential } = await setup();
      const userA = await insertTestUser({});
      const userB = await insertTestUser({});
      createdUserIds.push(userA.id, userB.id);
      await insertOperationProof(admin.id, credential.id, {
        actionClass: 'sensitive_write',
        surface: 'trpc',
        route: 'admin.users.resetAPIKey',
        method: 'mutation',
        targetKind: 'user',
        targetId: userA.id,
      });
      const caller = await createSessionCallerForUser(admin.id, { webSessionId });

      await expect(caller.admin.users.resetAPIKey({ userId: userA.id })).resolves.toMatchObject({
        success: true,
      });

      const cause = await refusal(caller.admin.users.resetAPIKey({ userId: userB.id }));
      expect(cause?.code).toBe('MFA_REQUIRED');
      expect(cause?.binding).toMatchObject({ targetKind: 'user', targetId: userB.id });
    });

    it('denies an admin procedure without a proof', async () => {
      const { user } = await setup();
      const caller = await createSessionCallerForUser(user.id);

      const cause = await refusal(caller.admin.getPermissions());

      expect(cause?.code).toBe('MFA_REQUIRED');
    });

    it('allows an admin procedure with a fresh proof', async () => {
      const { user, credential } = await setup();
      await insertProof(user.id, credential.id);
      const caller = await createSessionCallerForUser(user.id, { webSessionId });

      await expect(caller.admin.getPermissions()).resolves.toBeDefined();
    });

    it('denies multiple concurrent admin operations with the same code', async () => {
      const { user } = await setup();
      const caller = await createSessionCallerForUser(user.id);

      const results = await Promise.allSettled([
        caller.admin.getPermissions(),
        caller.admin.getPermissions(),
      ]);

      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
          expect(causeOf(result.reason)?.code).toBe('MFA_REQUIRED');
        }
      }
    });

    it('denies multiple concurrent bearer admin operations', async () => {
      const { user } = await setup();
      const caller = await createBearerCallerForUser(user.id);

      const results = await Promise.allSettled([
        caller.admin.getPermissions(),
        caller.admin.getPermissions(),
      ]);

      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') {
          expect(causeOf(result.reason)?.code).toBe('BEARER_NOT_ALLOWED');
        }
      }
    });

    it('denies a bearer admin procedure', async () => {
      const { user } = await setup();
      const caller = await createBearerCallerForUser(user.id);

      const cause = await refusal(caller.admin.getPermissions());

      expect(cause?.code).toBe('BEARER_NOT_ALLOWED');
    });
  });

  it('re-reads the permission on the primary and keeps the existing messages', async () => {
    const user = await insertTestUser({ is_admin: false });
    createdUserIds.push(user.id);

    await expect(assertPrivilegedPermission('admin', { user })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
    await expect(assertPrivilegedPermission('credit_manager', { user })).rejects.toMatchObject({
      message: 'Credit management access required',
    });
    await expect(assertPrivilegedPermission('session_viewer', { user })).rejects.toMatchObject({
      message: 'Session viewing access required',
    });
    await expect(assertPrivilegedPermission('superadmin', { user })).rejects.toMatchObject({
      message: 'Superadmin access required',
    });
    await expect(
      assertPrivilegedPermission('api_request_log_exporter', { user })
    ).rejects.toMatchObject({ message: 'API request log export access required' });
  });

  it('refuses an actor whose block timestamp is set', async () => {
    const user = await insertTestUser({ is_admin: true });
    createdUserIds.push(user.id);
    await db
      .update(kilocode_users)
      .set({ blocked_at: '2026-01-15T12:00:00.000Z' })
      .where(eq(kilocode_users.id, user.id));

    await expect(assertPrivilegedPermission('admin', { user })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
    await expect(
      requirePrivilegedActor(
        { permission: 'admin', actionClass: 'platform_read' },
        contextFor(user)
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a session whose pepper was rotated', async () => {
    const { user } = await setup();

    await expect(
      requirePrivilegedActor(
        { permission: 'admin', actionClass: 'platform_read' },
        { ...contextFor(user), webSessionPepper: 'stale-pepper' }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Reauthentication required' });
  });

  it('refuses a session credential supplied without a web session pepper', async () => {
    const user = await adminUser({ web_session_pepper: 'primary-row-pepper' });
    createdUserIds.push(user.id);

    await expect(
      requirePrivilegedActor(
        { permission: 'admin', actionClass: 'platform_read' },
        {
          user,
          credential: 'session',
          webSessionId,
          headersList: new Headers(),
          trpcPath: 'admin.test',
          trpcType: 'query',
        }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Reauthentication required' });
  });
});
