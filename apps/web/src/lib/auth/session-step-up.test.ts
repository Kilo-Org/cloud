import { beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { isoBase64URL } from '@simplewebauthn/server/helpers';

import {
  kilocode_users,
  passkey_credentials,
  session_step_up_challenges,
  session_step_up_proofs,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { evaluateStepUp, hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import type { StepUpOperation } from '@kilocode/web-shared/lib/admin/step-up-binding';
import type { StepUpOperationBinding } from '@kilocode/web-shared/lib/admin/privileged-access';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  buildAuthenticationResponse,
  createTestAuthenticator,
} from '@/tests/helpers/webauthn-test-authenticator';
import { createStepUpOptions, StepUpVerificationError, verifyStepUp } from './session-step-up';

const webSessionId = 'browser-session-one';
const otherSessionId = 'browser-session-two';

function sensitiveWriteOperation(targetUserId: string): StepUpOperation {
  return {
    surface: 'trpc',
    route: 'admin.users.update',
    method: 'mutation',
    target: { kind: 'user', id: targetUserId },
  };
}

function sensitiveWriteBinding(targetUserId: string): StepUpOperationBinding {
  return {
    actionClass: 'sensitive_write',
    surface: 'trpc',
    route: 'admin.users.update',
    method: 'mutation',
    targetKind: 'user',
    targetId: targetUserId,
  };
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (rejection: unknown) => rejection
  );
  expect(error).toBeInstanceOf(StepUpVerificationError);
  expect((error as StepUpVerificationError).code).toBe(code);
}

async function insertCredential(
  userId: string,
  authenticator = createTestAuthenticator(),
  signCount = 0
) {
  const [credential] = await db
    .insert(passkey_credentials)
    .values({
      kilo_user_id: userId,
      credential_id: authenticator.credentialId,
      public_key: isoBase64URL.fromBuffer(authenticator.cosePublicKey),
      sign_count: signCount,
    })
    .returning();
  return credential!;
}

async function proofCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: session_step_up_proofs.id })
    .from(session_step_up_proofs)
    .where(eq(session_step_up_proofs.kilo_user_id, userId));
  return rows.length;
}

function verifyParams(
  user: { id: string; web_session_pepper: string | null },
  challengeId: string,
  response: ReturnType<typeof buildAuthenticationResponse>,
  overrides: Partial<Parameters<typeof verifyStepUp>[0]> = {}
) {
  return {
    userId: user.id,
    webSessionId,
    webSessionPepper: user.web_session_pepper,
    challengeId,
    response,
    actionClass: 'platform_read' as const,
    ...overrides,
  };
}

describe('session step-up ceremony', () => {
  const createdUserIds: string[] = [];

  async function createAdmin(overrides: Parameters<typeof insertTestUser>[0] = {}) {
    const user = await insertTestUser({ is_admin: true, ...overrides });
    createdUserIds.push(user.id);
    return user;
  }

  beforeEach(async () => {
    for (const userId of createdUserIds.splice(0)) {
      await db
        .delete(session_step_up_proofs)
        .where(eq(session_step_up_proofs.kilo_user_id, userId));
      await db
        .delete(session_step_up_challenges)
        .where(eq(session_step_up_challenges.kilo_user_id, userId));
      await db.delete(passkey_credentials).where(eq(passkey_credentials.kilo_user_id, userId));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
  });

  it('requires user verification and only offers the actor’s own credentials', async () => {
    const user = await createAdmin();
    const otherUser = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    await insertCredential(otherUser.id, createTestAuthenticator());

    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });

    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials?.map(credential => credential.id)).toEqual([
      authenticator.credentialId,
    ]);

    const [stored] = await db
      .select()
      .from(session_step_up_challenges)
      .where(eq(session_step_up_challenges.id, challengeId));
    expect(stored?.session_id_hash).toBe(hashWebSessionId(webSessionId));
    expect(stored?.purpose).toBe('session');
    expect(stored?.kilo_user_id).toBe(user.id);
    expect(stored?.consumed_at).toBeNull();
  });

  it('refuses to mint options when the actor has no passkey', async () => {
    const user = await createAdmin();

    await expectRefusal(
      createStepUpOptions({ userId: user.id, webSessionId, actionClass: 'platform_read' }),
      'NOT_ENROLLED'
    );
  });

  it('mints a 30 minute session proof bound to the session hash', async () => {
    const user = await createAdmin({ web_session_pepper: 'session-pepper' });
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });

    const proof = await verifyStepUp(
      verifyParams(
        user,
        challengeId,
        buildAuthenticationResponse(authenticator, {
          challenge: options.challenge,
          counter: 1,
        })
      )
    );

    expect(proof.purpose).toBe('session');
    expect(proof.session_id_hash).toBe(hashWebSessionId(webSessionId));
    expect(proof.action_binding_hash).toBeNull();
    const ttlMinutes = (new Date(proof.expires_at).getTime() - Date.now()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(29.9);
    expect(ttlMinutes).toBeLessThan(30.1);
  });

  it('refuses a user-presence-only assertion', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });

    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 1,
            flags: 0x01,
          })
        )
      ),
      'VERIFICATION_FAILED'
    );
    expect(await proofCount(user.id)).toBe(0);
  });

  it.each([
    ['another web origin', { origin: 'https://evil.example' }],
    [
      'the native app origin',
      { origin: 'android:apk-key-hash:OYcNOQ5FiE-4sC2lDOSXm-xnss9fadmohHleZf24hec' },
    ],
  ])('refuses an assertion from %s', async (_label, overrides) => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });

    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 1,
            ...overrides,
          })
        )
      ),
      'VERIFICATION_FAILED'
    );
    expect(await proofCount(user.id)).toBe(0);
  });

  it('refuses an assertion for another rpId', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });

    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 1,
            rpIdHash: createTestAuthenticator('other.example').rpIdHash,
          })
        )
      ),
      'VERIFICATION_FAILED'
    );
  });

  it("refuses another user's passkey", async () => {
    const user = await createAdmin();
    const otherUser = await createAdmin();
    await insertCredential(user.id, createTestAuthenticator());
    const otherAuthenticator = createTestAuthenticator();
    await insertCredential(otherUser.id, otherAuthenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });

    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          challengeId,
          buildAuthenticationResponse(otherAuthenticator, {
            challenge: options.challenge,
            counter: 1,
          })
        )
      ),
      'UNKNOWN_CREDENTIAL'
    );
    expect(await proofCount(user.id)).toBe(0);
  });

  it('refuses a challenge minted for another session or user', async () => {
    const user = await createAdmin();
    const otherUser = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    await insertCredential(otherUser.id, createTestAuthenticator());

    const otherSession = await createStepUpOptions({
      userId: user.id,
      webSessionId: otherSessionId,
      actionClass: 'platform_read',
    });
    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          otherSession.challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: otherSession.options.challenge,
            counter: 1,
          })
        )
      ),
      'CHALLENGE_EXPIRED'
    );

    const otherUserChallenge = await createStepUpOptions({
      userId: otherUser.id,
      webSessionId,
      actionClass: 'platform_read',
    });
    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          otherUserChallenge.challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: otherUserChallenge.options.challenge,
            counter: 1,
          })
        )
      ),
      'CHALLENGE_EXPIRED'
    );
  });

  it('refuses a replay and an expired challenge', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });
    const response = buildAuthenticationResponse(authenticator, {
      challenge: options.challenge,
      counter: 1,
    });

    await expect(verifyStepUp(verifyParams(user, challengeId, response))).resolves.toBeDefined();
    await expectRefusal(
      verifyStepUp(verifyParams(user, challengeId, response)),
      'CHALLENGE_ALREADY_USED'
    );

    const expiredId = randomUUID();
    await db.insert(session_step_up_challenges).values({
      id: expiredId,
      challenge: isoBase64URL.fromBuffer(Buffer.from('expired-challenge')),
      kilo_user_id: user.id,
      session_id_hash: hashWebSessionId(webSessionId),
      purpose: 'session',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          expiredId,
          buildAuthenticationResponse(authenticator, {
            challenge: isoBase64URL.fromBuffer(Buffer.from('expired-challenge')),
            counter: 2,
          })
        )
      ),
      'CHALLENGE_EXPIRED'
    );
  });

  it('refuses a replayed signature counter', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator, 5);

    const first = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });
    await verifyStepUp(
      verifyParams(
        user,
        first.challengeId,
        buildAuthenticationResponse(authenticator, {
          challenge: first.options.challenge,
          counter: 6,
        })
      )
    );

    const second = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });
    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          second.challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: second.options.challenge,
            counter: 6,
          })
        )
      ),
      'VERIFICATION_FAILED'
    );
  });

  it('lets exactly one concurrent verification mint a proof', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });

    const results = await Promise.allSettled([
      verifyStepUp(
        verifyParams(
          user,
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 1,
          })
        )
      ),
      verifyStepUp(
        verifyParams(
          user,
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 1,
          })
        )
      ),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await proofCount(user.id)).toBe(1);
  });

  it('refuses to verify after a block, admin loss, or pepper rotation', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'blocked mid-ceremony' })
      .where(eq(kilocode_users.id, user.id));

    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 1,
          })
        )
      ),
      'SESSION_CHANGED'
    );
  });

  it('refuses to verify after the account state changes', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });
    await db
      .update(kilocode_users)
      .set({ blocked_at: new Date().toISOString(), blocked_reason: null })
      .where(eq(kilocode_users.id, user.id));

    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 1,
          })
        )
      ),
      'SESSION_CHANGED'
    );
  });

  it('mints a single-use operation proof for a sensitive write', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const binding = sensitiveWriteBinding(user.id);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'sensitive_write',
      binding,
    });

    const proof = await verifyStepUp(
      verifyParams(
        user,
        challengeId,
        buildAuthenticationResponse(authenticator, {
          challenge: options.challenge,
          counter: 1,
        }),
        { actionClass: 'sensitive_write', binding }
      )
    );
    expect(proof.purpose).toBe('operation');
    expect(proof.action_binding_hash).not.toBeNull();
    expect(proof.consumed_at).toBeNull();
    expect((new Date(proof.expires_at).getTime() - Date.now()) / 60_000).toBeGreaterThan(4.9);

    // The matching operation claims the proof once.
    const claimed = await evaluateStepUp({
      userId: user.id,
      webSessionId,
      actionClass: 'sensitive_write',
      operation: sensitiveWriteOperation(user.id),
    });
    expect(claimed.state.status).toBe('fresh');
    expect(claimed.proof?.consumed_at).not.toBeNull();

    // A second use of the same proof is refused.
    const reused = await evaluateStepUp({
      userId: user.id,
      webSessionId,
      actionClass: 'sensitive_write',
      operation: sensitiveWriteOperation(user.id),
    });
    expect(reused.state.status).toBe('required');
  });

  it('refuses an operation proof bound to a different target or class', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const binding = sensitiveWriteBinding(user.id);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'sensitive_write',
      binding,
    });
    await verifyStepUp(
      verifyParams(
        user,
        challengeId,
        buildAuthenticationResponse(authenticator, {
          challenge: options.challenge,
          counter: 1,
        }),
        { actionClass: 'sensitive_write', binding }
      )
    );

    for (const request of [
      {
        actionClass: 'sensitive_write' as const,
        operation: { ...sensitiveWriteOperation(user.id), target: { kind: 'user' as const, id: 'someone-else' } },
      },
      {
        actionClass: 'sensitive_write' as const,
        operation: { ...sensitiveWriteOperation(user.id), route: 'admin.users.delete' },
      },
      {
        actionClass: 'support_write' as const,
        operation: { ...sensitiveWriteOperation(user.id), surface: 'rest' as const },
      },
    ]) {
      const refused = await evaluateStepUp({
        userId: user.id,
        webSessionId,
        ...request,
      });
      expect(refused.state.status).not.toBe('fresh');
    }

    // None of the refusals spent the proof the matching operation still owns.
    const claimed = await evaluateStepUp({
      userId: user.id,
      webSessionId,
      actionClass: 'sensitive_write',
      operation: sensitiveWriteOperation(user.id),
    });
    expect(claimed.state.status).toBe('fresh');
  });

  it('never accepts a session proof for an operation-class request', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });
    await verifyStepUp(
      verifyParams(
        user,
        challengeId,
        buildAuthenticationResponse(authenticator, {
          challenge: options.challenge,
          counter: 1,
        })
      )
    );

    const session = await evaluateStepUp({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });
    expect(session.state.status).toBe('fresh');

    const operation = await evaluateStepUp({
      userId: user.id,
      webSessionId,
      actionClass: 'sensitive_write',
      operation: sensitiveWriteOperation(user.id),
    });
    expect(operation.state.status).toBe('required');

    // The session proof is still live for read-grade classes afterwards.
    const stillFresh = await evaluateStepUp({
      userId: user.id,
      webSessionId,
      actionClass: 'platform_read',
    });
    expect(stillFresh.state.status).toBe('fresh');
  });

  it('keeps the 30-minute session proof for read-grade classes', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'support_read',
    });
    const proof = await verifyStepUp(
      verifyParams(
        user,
        challengeId,
        buildAuthenticationResponse(authenticator, {
          challenge: options.challenge,
          counter: 1,
        }),
        { actionClass: 'support_read' }
      )
    );
    expect(proof.purpose).toBe('session');
    expect((new Date(proof.expires_at).getTime() - Date.now()) / 60_000).toBeGreaterThan(29.9);

    const first = await evaluateStepUp({
      userId: user.id,
      webSessionId,
      actionClass: 'support_read',
    });
    const second = await evaluateStepUp({
      userId: user.id,
      webSessionId,
      actionClass: 'support_read',
    });
    expect(first.state.status).toBe('fresh');
    expect(second.state.status).toBe('fresh');
    expect(second.proof?.consumed_at).toBeNull();
  });

  it('refuses to mint an operation proof without a binding', async () => {
    const user = await createAdmin();
    await insertCredential(user.id, createTestAuthenticator());

    await expectRefusal(
      createStepUpOptions({
        userId: user.id,
        webSessionId,
        actionClass: 'sensitive_write',
      }),
      'INVALID_BINDING'
    );
  });

  it('refuses a challenge minted for another operation', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);
    const binding = sensitiveWriteBinding(user.id);
    const { challengeId, options } = await createStepUpOptions({
      userId: user.id,
      webSessionId,
      actionClass: 'sensitive_write',
      binding,
    });

    await expectRefusal(
      verifyStepUp(
        verifyParams(
          user,
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter: 1,
          }),
          {
            actionClass: 'sensitive_write',
            binding: { ...binding, route: 'admin.users.delete' },
          }
        )
      ),
      'INVALID_BINDING'
    );
  });

  it('supersedes the previous session proof', async () => {
    const user = await createAdmin();
    const authenticator = createTestAuthenticator();
    await insertCredential(user.id, authenticator);

    for (const counter of [1, 2]) {
      const { challengeId, options } = await createStepUpOptions({
        userId: user.id,
        webSessionId,
        actionClass: 'platform_read',
      });
      await verifyStepUp(
        verifyParams(
          user,
          challengeId,
          buildAuthenticationResponse(authenticator, {
            challenge: options.challenge,
            counter,
          })
        )
      );
    }

    const proofs = await db
      .select()
      .from(session_step_up_proofs)
      .where(
        and(
          eq(session_step_up_proofs.kilo_user_id, user.id),
          eq(session_step_up_proofs.session_id_hash, hashWebSessionId(webSessionId))
        )
      );
    expect(proofs).toHaveLength(2);
    expect(proofs.filter(proof => proof.revoked_at === null)).toHaveLength(1);
    expect(proofs.filter(proof => proof.revoked_reason === 'superseded')).toHaveLength(1);
  });
});
