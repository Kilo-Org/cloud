jest.mock('@kilocode/web-shared/lib/admin/step-up-store', () => {
  const actual = jest.requireActual('@kilocode/web-shared/lib/admin/step-up-store');
  return { ...actual, evaluateStepUp: jest.fn(actual.evaluateStepUp) };
});

import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { kilocode_users, passkey_credentials, session_step_up_proofs } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import { hashWebSessionId, revokeStepUpProofs } from '@kilocode/web-shared/lib/admin/step-up-store';
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

    it('uses the same uniform freshness for a sensitive write', async () => {
      const { user, credential } = await setup();
      await insertProof(user.id, credential.id);

      const actor = await requirePrivilegedActor(
        {
          permission: 'admin',
          actionClass: 'sensitive_write',
          inventoryId: 'trpc.admin.users',
          target: { kind: 'user', id: 'target-user' },
        },
        contextFor(user)
      );

      expect(actor.assurance.stepUp.status).toBe('fresh');
    });

    it('reuses the state measured by the admin middleware', async () => {
      const { user } = await setup();

      const actor = await requirePrivilegedActor(
        { permission: 'admin', actionClass: 'platform_read' },
        {
          ...contextFor(user),
          adminStepUpState: {
            status: 'fresh',
            method: 'webauthn_uv',
            verifiedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }
      );

      expect(actor.assurance.stepUp.status).toBe('fresh');
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
