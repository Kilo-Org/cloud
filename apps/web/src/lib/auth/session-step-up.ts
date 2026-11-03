import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { decodeClientDataJSON, isoBase64URL } from '@simplewebauthn/server/helpers';
import {
  kilocode_users,
  passkey_credentials,
  session_step_up_challenges,
  session_step_up_proofs,
  type SessionStepUpProof,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { PrivilegedActionClass } from '@kilocode/web-shared/lib/admin/privileged-access';
import type { User } from '@kilocode/db/schema';
import { hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import {
  STEP_UP_CHALLENGE_TTL_MS,
  stepUpPolicyFor,
  type StepUpProofPurpose,
} from '@kilocode/web-shared/lib/admin/step-up-policy';
import { isWebSessionCurrent } from '@kilocode/web-shared/lib/web-session-revocation';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { recordAdminAction } from '@/lib/admin/admin-action-audit';
import { advancePasskeyCounter, getWebRelyingParty } from '@/lib/auth/passkey';

export type StepUpErrorCode =
  | 'SESSION_UNBOUND'
  | 'NOT_ENROLLED'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_ALREADY_USED'
  | 'WRONG_CHALLENGE'
  | 'UNKNOWN_CREDENTIAL'
  | 'SESSION_CHANGED'
  | 'VERIFICATION_FAILED';

export class StepUpVerificationError extends Error {
  readonly code: StepUpErrorCode;

  constructor(code: StepUpErrorCode) {
    super(code);
    this.name = 'StepUpVerificationError';
    this.code = code;
  }
}

export type StepUpOptionsResult = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

type ChallengePurpose = StepUpProofPurpose;

/**
 * Mint UV-required authentication options for the actor's own passkeys and
 * store the challenge bound to this browser session. The challenge is the only
 * authority to mint a proof; the client never supplies it.
 */
export async function createStepUpOptions(params: {
  userId: string;
  webSessionId: string | null | undefined;
  actionClass: PrivilegedActionClass;
}): Promise<StepUpOptionsResult> {
  if (!params.webSessionId) {
    throw new StepUpVerificationError('SESSION_UNBOUND');
  }

  const policy = stepUpPolicyFor(params.actionClass);
  const { rpId } = getWebRelyingParty();

  const credentials = await db
    .select({
      credential_id: passkey_credentials.credential_id,
      transports: passkey_credentials.transports,
    })
    .from(passkey_credentials)
    .where(eq(passkey_credentials.kilo_user_id, params.userId));

  if (credentials.length === 0) {
    throw new StepUpVerificationError('NOT_ENROLLED');
  }

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: credentials.map(credential => ({
      id: credential.credential_id,
      transports: credential.transports ?? undefined,
    })),
    userVerification: 'required',
  });

  const challengeId = randomUUID();
  await db.insert(session_step_up_challenges).values({
    id: challengeId,
    challenge: options.challenge,
    kilo_user_id: params.userId,
    session_id_hash: hashWebSessionId(params.webSessionId),
    purpose: policy.purpose,
    action_binding_hash: null,
    expires_at: new Date(Date.now() + STEP_UP_CHALLENGE_TTL_MS).toISOString(),
  });

  return { challengeId, options };
}

/**
 * Consume the challenge atomically. Exactly one caller can win the
 * `UPDATE ... WHERE consumed_at IS NULL AND expires_at > NOW()`; a challenge
 * minted for another session or user matches no row and is reported as
 * expired so it cannot be used as an oracle.
 */
async function consumeChallenge(params: {
  challengeId: string;
  userId: string;
  sessionIdHash: string;
  purpose: ChallengePurpose;
}): Promise<{ challenge: string }> {
  const [consumed] = await db
    .update(session_step_up_challenges)
    .set({ consumed_at: sql`NOW()` })
    .where(
      and(
        eq(session_step_up_challenges.id, params.challengeId),
        eq(session_step_up_challenges.kilo_user_id, params.userId),
        eq(session_step_up_challenges.session_id_hash, params.sessionIdHash),
        eq(session_step_up_challenges.purpose, params.purpose),
        isNull(session_step_up_challenges.consumed_at),
        sql`${session_step_up_challenges.expires_at} > NOW()`
      )
    )
    .returning({
      challenge: session_step_up_challenges.challenge,
    });

  if (consumed) {
    return { challenge: consumed.challenge };
  }

  const [existing] = await db
    .select({ consumed_at: session_step_up_challenges.consumed_at })
    .from(session_step_up_challenges)
    .where(
      and(
        eq(session_step_up_challenges.id, params.challengeId),
        eq(session_step_up_challenges.kilo_user_id, params.userId),
        eq(session_step_up_challenges.session_id_hash, params.sessionIdHash),
        eq(session_step_up_challenges.purpose, params.purpose)
      )
    )
    .limit(1);

  if (existing?.consumed_at) {
    throw new StepUpVerificationError('CHALLENGE_ALREADY_USED');
  }
  throw new StepUpVerificationError('CHALLENGE_EXPIRED');
}

function readPresentedChallenge(response: {
  response?: { clientDataJSON?: unknown };
}): string | null {
  if (typeof response.response?.clientDataJSON !== 'string') return null;
  try {
    return decodeClientDataJSON(response.response.clientDataJSON).challenge;
  } catch {
    return null;
  }
}

async function loadCurrentAdmin(
  userId: string,
  webSessionPepper: string | null | undefined
): Promise<User> {
  const currentUser = await db.query.kilocode_users.findFirst({
    where: eq(kilocode_users.id, userId),
  });

  if (
    !currentUser ||
    currentUser.blocked_reason !== null ||
    !currentUser.is_admin ||
    !isWebSessionCurrent(webSessionPepper, currentUser)
  ) {
    throw new StepUpVerificationError('SESSION_CHANGED');
  }

  return currentUser;
}

/**
 * Verify a step-up assertion against the single-use challenge stored for this
 * session and mint a proof. UV is mandatory: a user-presence-only assertion is
 * refused even if the signature is valid.
 */
export async function verifyStepUp(params: {
  userId: string;
  webSessionId: string | null | undefined;
  webSessionPepper: string | null | undefined;
  challengeId: string;
  response: AuthenticationResponseJSON;
  actionClass: PrivilegedActionClass;
}): Promise<SessionStepUpProof> {
  if (!params.webSessionId) {
    throw new StepUpVerificationError('SESSION_UNBOUND');
  }

  const credentialId: unknown = params.response.id;
  if (typeof credentialId !== 'string' || credentialId.length === 0) {
    throw new StepUpVerificationError('VERIFICATION_FAILED');
  }

  const policy = stepUpPolicyFor(params.actionClass);
  const sessionIdHash = hashWebSessionId(params.webSessionId);
  const { rpId, expectedOrigin } = getWebRelyingParty();

  const challenge = await consumeChallenge({
    challengeId: params.challengeId,
    userId: params.userId,
    sessionIdHash,
    purpose: policy.purpose,
  });

  const presentedChallenge = readPresentedChallenge(params.response);
  if (presentedChallenge !== null && presentedChallenge !== challenge.challenge) {
    throw new StepUpVerificationError('WRONG_CHALLENGE');
  }

  const [credential] = await db
    .select()
    .from(passkey_credentials)
    .where(
      and(
        eq(passkey_credentials.credential_id, credentialId),
        eq(passkey_credentials.kilo_user_id, params.userId)
      )
    )
    .limit(1);

  if (!credential) {
    throw new StepUpVerificationError('UNKNOWN_CREDENTIAL');
  }

  let newCounter: number;
  try {
    const verification = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin,
      expectedRPID: rpId,
      credential: {
        id: credential.credential_id,
        publicKey: isoBase64URL.toBuffer(credential.public_key),
        counter: credential.sign_count,
        transports: credential.transports ?? undefined,
      },
      requireUserVerification: true,
    });
    if (!verification.verified || verification.authenticationInfo.userVerified !== true) {
      throw new StepUpVerificationError('VERIFICATION_FAILED');
    }
    newCounter = verification.authenticationInfo.newCounter;
  } catch (error) {
    if (error instanceof StepUpVerificationError) throw error;
    throw new StepUpVerificationError('VERIFICATION_FAILED');
  }

  if (credential.sign_count !== 0 && newCounter <= credential.sign_count) {
    // The counter only moves forward; a lower or equal value is a replayed
    // assertion from a cloned authenticator.
    throw new StepUpVerificationError('VERIFICATION_FAILED');
  }

  const admin = await loadCurrentAdmin(params.userId, params.webSessionPepper);

  const verifiedAt = new Date();
  const expiresAt = new Date(verifiedAt.getTime() + policy.maxAgeMs);

  const proof = await db.transaction(async tx => {
    if (!(await advancePasskeyCounter(credential, newCounter, tx))) {
      throw new StepUpVerificationError('VERIFICATION_FAILED');
    }

    if (policy.purpose === 'session') {
      // A newer verification supersedes the older session proof rather than
      // leaving two live proofs for the same browser session.
      await tx
        .update(session_step_up_proofs)
        .set({ revoked_at: verifiedAt.toISOString(), revoked_reason: 'superseded' })
        .where(
          and(
            eq(session_step_up_proofs.kilo_user_id, params.userId),
            eq(session_step_up_proofs.session_id_hash, sessionIdHash),
            eq(session_step_up_proofs.purpose, 'session'),
            isNull(session_step_up_proofs.revoked_at)
          )
        );
    }

    const [inserted] = await tx
      .insert(session_step_up_proofs)
      .values({
        kilo_user_id: params.userId,
        session_id_hash: sessionIdHash,
        method: 'webauthn_uv',
        passkey_credential_id: credential.id,
        purpose: policy.purpose,
        action_binding_hash: null,
        verified_at: verifiedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .returning();

    if (!inserted) {
      throw new StepUpVerificationError('VERIFICATION_FAILED');
    }
    return inserted;
  });

  logExceptInTest(
    JSON.stringify({
      event: 'admin_step_up',
      outcome: 'verified',
      kiloUserId: params.userId,
      method: 'webauthn_uv',
      purpose: policy.purpose,
      expiresAt: expiresAt.toISOString(),
    })
  );

  // The proof is already durable. An audit write failure is reported, but
  // must not turn a successful verification into an error the client retries
  // against an already-consumed challenge.
  try {
    await recordAdminAction(
      {
        user: {
          id: admin.id,
          google_user_email: admin.google_user_email,
          google_user_name: admin.google_user_name,
          is_super_admin: admin.is_super_admin,
        },
        authViaToken: false,
        credential: 'session',
        trpcPath: '/api/auth/step-up',
      },
      {
        action: 'admin.step_up.verified',
        target: { type: 'user', id: params.userId },
        message: 'Verified MFA for a privileged session',
        metadata: { purpose: policy.purpose },
      }
    );
  } catch (error) {
    captureException(error, { tags: { source: 'admin_step_up_audit' } });
  }

  return proof;
}
