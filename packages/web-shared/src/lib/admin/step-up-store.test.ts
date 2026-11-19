import { afterEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import {
  kilocode_users,
  passkey_credentials,
  session_step_up_challenges,
  session_step_up_proofs,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  evaluateStepUp,
  hashStepUpBinding,
  hashWebSessionId,
} from '@kilocode/web-shared/lib/admin/step-up-store';
import { STEP_UP_CHALLENGE_TTL_MS } from '@kilocode/web-shared/lib/admin/step-up-policy';
import type { StepUpOperation } from '@kilocode/web-shared/lib/admin/step-up-binding';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

const webSessionId = 'step-up-store-browser-session';

function updateUserOperation(targetUserId: string): StepUpOperation {
  return {
    surface: 'trpc',
    route: 'admin.users.update',
    method: 'mutation',
    target: { kind: 'user', id: targetUserId },
  };
}

function supportWriteOperation(targetUserId: string): StepUpOperation {
  return {
    surface: 'trpc',
    route: 'admin.support.write',
    method: 'mutation',
    target: { kind: 'user', id: targetUserId },
  };
}

const createdUserIds: string[] = [];

async function createAdmin() {
  const user = await insertTestUser({ is_admin: true });
  createdUserIds.push(user.id);
  return user;
}

async function insertCredential(userId: string) {
  const [credential] = await db
    .insert(passkey_credentials)
    .values({
      kilo_user_id: userId,
      credential_id: `credential-${crypto.randomUUID()}`,
      public_key: `public-key-${crypto.randomUUID()}`,
    })
    .returning();
  return credential!;
}

async function insertProof(params: {
  userId: string;
  credentialId: string;
  purpose: 'session' | 'operation';
  actionBindingHash?: string;
  sessionId?: string;
  verifiedAt: Date;
  expiresAt: Date;
}) {
  const [proof] = await db
    .insert(session_step_up_proofs)
    .values({
      kilo_user_id: params.userId,
      passkey_credential_id: params.credentialId,
      session_id_hash: hashWebSessionId(params.sessionId ?? webSessionId),
      method: 'webauthn_uv',
      purpose: params.purpose,
      action_binding_hash: params.actionBindingHash ?? null,
      verified_at: params.verifiedAt.toISOString(),
      expires_at: params.expiresAt.toISOString(),
    })
    .returning();
  return proof!;
}

async function proofRow(proofId: string) {
  const [row] = await db
    .select()
    .from(session_step_up_proofs)
    .where(eq(session_step_up_proofs.id, proofId));
  return row!;
}

afterEach(async () => {
  for (const userId of createdUserIds.splice(0)) {
    await db.delete(session_step_up_proofs).where(eq(session_step_up_proofs.kilo_user_id, userId));
    await db
      .delete(session_step_up_challenges)
      .where(eq(session_step_up_challenges.kilo_user_id, userId));
    await db.delete(passkey_credentials).where(eq(passkey_credentials.kilo_user_id, userId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }
});

describe('evaluateStepUp', () => {
  it('refuses a session proof older than the ordinary window and accepts one inside it', async () => {
    const user = await createAdmin();
    const credential = await insertCredential(user.id);
    const now = new Date();

    // Verified 31 minutes ago, but not yet expired: only the ordinary max age
    // can refuse this one.
    await insertProof({
      userId: user.id,
      credentialId: credential.id,
      purpose: 'session',
      verifiedAt: new Date(now.getTime() - 31 * 60 * 1000),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    });

    const stale = await evaluateStepUp(
      { userId: user.id, webSessionId, actionClass: 'platform_read', now },
      db
    );
    expect(stale.state.status).toBe('expired');
    expect(stale.proof).toBeNull();

    await insertProof({
      userId: user.id,
      credentialId: credential.id,
      purpose: 'session',
      verifiedAt: new Date(now.getTime() - 60 * 1000),
      expiresAt: new Date(now.getTime() + 29 * 60 * 1000),
    });

    const fresh = await evaluateStepUp(
      { userId: user.id, webSessionId, actionClass: 'platform_read', now },
      db
    );
    expect(fresh.state.status).toBe('fresh');
  });

  it('does not consume a session proof and evaluates it again', async () => {
    const user = await createAdmin();
    const credential = await insertCredential(user.id);
    const now = new Date();

    const proof = await insertProof({
      userId: user.id,
      credentialId: credential.id,
      purpose: 'session',
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    });

    const first = await evaluateStepUp(
      { userId: user.id, webSessionId, actionClass: 'platform_read', now },
      db
    );
    const second = await evaluateStepUp(
      { userId: user.id, webSessionId, actionClass: 'platform_write', now },
      db
    );

    expect(first.state.status).toBe('fresh');
    expect(second.state.status).toBe('fresh');
    expect((await proofRow(proof.id)).consumed_at).toBeNull();
  });

  it('claims a matching operation proof once', async () => {
    const user = await createAdmin();
    const credential = await insertCredential(user.id);
    const now = new Date();
    const operation = updateUserOperation(user.id);

    const proof = await insertProof({
      userId: user.id,
      credentialId: credential.id,
      purpose: 'operation',
      actionBindingHash: hashStepUpBinding('sensitive_write', operation),
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + STEP_UP_CHALLENGE_TTL_MS),
    });

    const first = await evaluateStepUp(
      { userId: user.id, webSessionId, actionClass: 'sensitive_write', operation, now },
      db
    );
    expect(first.state.status).toBe('fresh');
    expect((await proofRow(proof.id)).consumed_at).not.toBeNull();

    const second = await evaluateStepUp(
      { userId: user.id, webSessionId, actionClass: 'sensitive_write', operation, now },
      db
    );
    expect(second.state.status).toBe('required');
    expect(second.proof).toBeNull();
  });

  it('refuses an operation proof minted for another target and leaves it unconsumed', async () => {
    const user = await createAdmin();
    const credential = await insertCredential(user.id);
    const now = new Date();

    const proof = await insertProof({
      userId: user.id,
      credentialId: credential.id,
      purpose: 'operation',
      actionBindingHash: hashStepUpBinding(
        'sensitive_write',
        updateUserOperation('some-other-target-user')
      ),
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + STEP_UP_CHALLENGE_TTL_MS),
    });

    const evaluation = await evaluateStepUp(
      {
        userId: user.id,
        webSessionId,
        actionClass: 'sensitive_write',
        operation: updateUserOperation(user.id),
        now,
      },
      db
    );

    expect(evaluation.state.status).toBe('required');
    expect(evaluation.proof).toBeNull();
    expect((await proofRow(proof.id)).consumed_at).toBeNull();
  });

  it('refuses an operation proof minted for another action class', async () => {
    const user = await createAdmin();
    const credential = await insertCredential(user.id);
    const now = new Date();
    const targetId = user.id;

    const proof = await insertProof({
      userId: user.id,
      credentialId: credential.id,
      purpose: 'operation',
      actionBindingHash: hashStepUpBinding('support_write', supportWriteOperation(targetId)),
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + STEP_UP_CHALLENGE_TTL_MS),
    });

    const evaluation = await evaluateStepUp(
      {
        userId: user.id,
        webSessionId,
        actionClass: 'sensitive_write',
        operation: updateUserOperation(targetId),
        now,
      },
      db
    );

    expect(evaluation.state.status).toBe('required');
    expect((await proofRow(proof.id)).consumed_at).toBeNull();
  });

  it('never satisfies an operation request with a session proof', async () => {
    const user = await createAdmin();
    const credential = await insertCredential(user.id);
    const now = new Date();

    const proof = await insertProof({
      userId: user.id,
      credentialId: credential.id,
      purpose: 'session',
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    });

    const evaluation = await evaluateStepUp(
      {
        userId: user.id,
        webSessionId,
        actionClass: 'sensitive_write',
        operation: updateUserOperation(user.id),
        now,
      },
      db
    );

    expect(evaluation.state.status).toBe('required');
    expect(evaluation.proof).toBeNull();
    expect((await proofRow(proof.id)).consumed_at).toBeNull();
  });

  it('throws when an operation class is evaluated without an operation', async () => {
    const user = await createAdmin();
    await insertCredential(user.id);

    await expect(
      evaluateStepUp({ userId: user.id, webSessionId, actionClass: 'sensitive_write' }, db)
    ).rejects.toThrow('An operation step-up proof requires the operation it authorizes');
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const user = await createAdmin();
    const credential = await insertCredential(user.id);
    const now = new Date();
    const operation = updateUserOperation(user.id);

    const proof = await insertProof({
      userId: user.id,
      credentialId: credential.id,
      purpose: 'operation',
      actionBindingHash: hashStepUpBinding('sensitive_write', operation),
      verifiedAt: now,
      expiresAt: new Date(now.getTime() + STEP_UP_CHALLENGE_TTL_MS),
    });

    const results = await Promise.all([
      evaluateStepUp(
        { userId: user.id, webSessionId, actionClass: 'sensitive_write', operation, now },
        db
      ),
      evaluateStepUp(
        { userId: user.id, webSessionId, actionClass: 'sensitive_write', operation, now },
        db
      ),
    ]);
    const statuses = results.map(result => result.state.status).sort();

    expect(statuses).toEqual(['fresh', 'required']);
    expect((await proofRow(proof.id)).consumed_at).not.toBeNull();
  });
});
