import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { kilocode_users, passkey_credentials, session_step_up_proofs } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import { hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import {
  __adminStepUpTest__,
  getAdminStepUpMode,
  type AdminStepUpMode,
} from '@kilocode/web-shared/lib/config.server';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createSessionCallerForUser } from '@/routers/test-utils';
import { assertPrivilegedPermission, requirePrivilegedActor } from './require-privileged-actor';

const webSessionId = 'guard-web-session';

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
    purpose?: 'session' | 'operation';
    actionBindingHash?: string | null;
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
      purpose: params.purpose ?? 'session',
      action_binding_hash: params.actionBindingHash ?? null,
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

describe('requirePrivilegedActor', () => {
  const originalMode = process.env.ADMIN_STEP_UP_MODE;
  const createdUserIds: string[] = [];

  async function setup() {
    const user = await adminUser();
    createdUserIds.push(user.id);
    const credential = await insertPasskey(user.id);
    return { user, credential };
  }

  beforeEach(() => {
    process.env.ADMIN_STEP_UP_MODE = 'observe';
  });

  afterEach(async () => {
    process.env.ADMIN_STEP_UP_MODE = originalMode;
    __adminStepUpTest__.setEnforcementAvailable(null);
    for (const userId of createdUserIds.splice(0)) {
      await db
        .delete(session_step_up_proofs)
        .where(eq(session_step_up_proofs.kilo_user_id, userId));
      await db.delete(passkey_credentials).where(eq(passkey_credentials.kilo_user_id, userId));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
  });

  it('observes a missing proof without denying', async () => {
    const { user } = await setup();

    const actor = await requirePrivilegedActor(
      { permission: 'admin', actionClass: 'platform_read' },
      contextFor(user)
    );

    expect(actor.assurance.stepUp.status).toBe('required');
    expect(actor.credential).toBe('session');
  });

  it('reports a fresh proof for this session', async () => {
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

    const actor = await requirePrivilegedActor(
      { permission: 'admin', actionClass: 'platform_read' },
      contextFor(user)
    );

    expect(actor.assurance.stepUp.status).toBe('required');
  });

  it('reports an expired proof with its verification time', async () => {
    const { user, credential } = await setup();
    const verifiedAt = new Date(Date.now() - 20 * 60_000);
    await insertProof(user.id, credential.id, {
      verifiedAt,
      expiresAt: new Date(verifiedAt.getTime() + 15 * 60_000),
    });

    const actor = await requirePrivilegedActor(
      { permission: 'admin', actionClass: 'platform_read' },
      contextFor(user)
    );

    expect(actor.assurance.stepUp).toEqual({
      status: 'expired',
      verifiedAt: verifiedAt.toISOString(),
    });
  });

  it('does not treat a revoked proof as fresh', async () => {
    const { user, credential } = await setup();
    await insertProof(user.id, credential.id, { revokedAt: new Date() });

    const actor = await requirePrivilegedActor(
      { permission: 'admin', actionClass: 'platform_read' },
      contextFor(user)
    );

    expect(actor.assurance.stepUp.status).not.toBe('fresh');
  });

  it('requires an operation-bound proof for a sensitive write', async () => {
    const { user, credential } = await setup();
    // A fresh session proof is not enough for a sensitive action.
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

    expect(actor.assurance.stepUp.status).toBe('required');
  });

  it('does not authorize a sensitive write with a proof for another target', async () => {
    const { user, credential } = await setup();
    const verifiedAt = new Date();

    const first = await requirePrivilegedActor(
      {
        permission: 'admin',
        actionClass: 'sensitive_write',
        inventoryId: 'trpc.admin.users',
        target: { kind: 'user', id: 'target-user' },
      },
      contextFor(user)
    );
    expect(first.assurance.stepUp.status).toBe('required');

    await insertProof(user.id, credential.id, {
      purpose: 'operation',
      actionBindingHash: 'a-binding-for-another-action',
      verifiedAt,
      expiresAt: new Date(verifiedAt.getTime() + 5 * 60_000),
    });

    const second = await requirePrivilegedActor(
      {
        permission: 'admin',
        actionClass: 'sensitive_write',
        inventoryId: 'trpc.admin.users',
        target: { kind: 'user', id: 'target-user' },
      },
      contextFor(user)
    );

    expect(second.assurance.stepUp.status).toBe('required');
  });

  it('does not deny a bearer credential in observe mode', async () => {
    const { user } = await setup();

    const actor = await requirePrivilegedActor(
      { permission: 'admin', actionClass: 'platform_read' },
      { ...contextFor(user), credential: 'human_bearer', authViaToken: true }
    );

    expect(actor.assurance.stepUp.status).toBe('session_unbound');
  });

  it('refuses a bearer credential only when enforcement is forced on', async () => {
    const { user } = await setup();
    process.env.ADMIN_STEP_UP_MODE = 'enforce';
    __adminStepUpTest__.setEnforcementAvailable(true);

    const error: unknown = await requirePrivilegedActor(
      { permission: 'admin', actionClass: 'platform_read' },
      { ...contextFor(user), credential: 'human_bearer', authViaToken: true }
    ).then(
      () => null,
      (rejection: unknown) => rejection
    );

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('FORBIDDEN');
    expect((error as TRPCError).cause).toBeInstanceOf(StepUpRequiredError);
    expect(((error as TRPCError).cause as StepUpRequiredError).code).toBe('BEARER_NOT_ALLOWED');
  });

  it('reuses the state measured by the admin middleware', async () => {
    const { user } = await setup();

    const actor = await requirePrivilegedActor(
      { permission: 'admin', actionClass: 'sensitive_write' },
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

  it('lets an observed admin procedure complete without a proof', async () => {
    const { user } = await setup();
    const caller = await createSessionCallerForUser(user.id);

    await expect(caller.admin.getPermissions()).resolves.toBeDefined();
  });

  it('adds no step-up read when mode is off', async () => {
    const { user } = await setup();
    process.env.ADMIN_STEP_UP_MODE = 'off';

    const actor = await requirePrivilegedActor(
      { permission: 'admin', actionClass: 'platform_read' },
      contextFor(user)
    );

    expect(actor.assurance.stepUp).toEqual({ status: 'absent' });
  });
});

describe('ADMIN_STEP_UP_MODE', () => {
  const originalMode = process.env.ADMIN_STEP_UP_MODE;

  afterEach(() => {
    process.env.ADMIN_STEP_UP_MODE = originalMode;
    __adminStepUpTest__.setEnforcementAvailable(null);
  });

  it.each<[string | undefined, AdminStepUpMode]>([
    [undefined, 'off'],
    ['', 'off'],
    ['off', 'off'],
    ['observe', 'observe'],
    ['OBSERVE', 'observe'],
    ['enforce', 'observe'],
    ['something-else', 'off'],
  ])('parses %s as %s', (raw, expected) => {
    if (raw === undefined) delete process.env.ADMIN_STEP_UP_MODE;
    else process.env.ADMIN_STEP_UP_MODE = raw;
    expect(getAdminStepUpMode()).toBe(expected);
  });

  it('reaches enforce only through the test seam', () => {
    process.env.ADMIN_STEP_UP_MODE = 'enforce';
    __adminStepUpTest__.setEnforcementAvailable(true);
    expect(getAdminStepUpMode()).toBe('enforce');
  });
});
