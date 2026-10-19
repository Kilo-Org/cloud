import { SESSION_INGEST_INVALIDATION_AUDIENCE } from './internal-service-token-audiences';
import { signKiloToken, verifyKiloToken, type KiloTokenPayload } from './kilo-token';

export const SESSION_ACCESS_INVALIDATION_CREDENTIAL_TTL_SECONDS = 60;

export type SessionAccessInvalidationCredentialVerification =
  | { ok: true }
  | { ok: false; reason: 'invalid_credential' | 'subject_mismatch' };

export async function signSessionAccessInvalidationCredential(input: {
  userId: string;
  organizationId: string;
  secret: string;
  now?: Date;
}): Promise<string> {
  const { token } = await signKiloToken({
    userId: input.userId,
    secret: input.secret,
    expiresInSeconds: SESSION_ACCESS_INVALIDATION_CREDENTIAL_TTL_SECONDS,
    audience: SESSION_INGEST_INVALIDATION_AUDIENCE,
    extra: { organizationId: input.organizationId },
    now: input.now ?? new Date(),
  });
  return token;
}

export async function verifySessionAccessInvalidationCredential(input: {
  token: string;
  secret: string;
  userId: string;
  organizationId: string;
}): Promise<SessionAccessInvalidationCredentialVerification> {
  let payload: KiloTokenPayload;
  try {
    payload = await verifyKiloToken(input.token, input.secret, {
      audience: SESSION_INGEST_INVALIDATION_AUDIENCE,
    });
  } catch {
    return { ok: false, reason: 'invalid_credential' };
  }

  if (payload.kiloUserId !== input.userId || payload.organizationId !== input.organizationId) {
    return { ok: false, reason: 'subject_mismatch' };
  }

  return { ok: true };
}
