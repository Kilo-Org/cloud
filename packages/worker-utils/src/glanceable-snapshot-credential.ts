import { GLANCEABLE_SNAPSHOT_AUDIENCE } from './internal-service-token-audiences';
import { signKiloToken, verifyKiloToken } from './kilo-token';

export const GLANCEABLE_SNAPSHOT_CREDENTIAL_TTL_SECONDS = 120;

export type GlanceableSnapshotCredentialVerification = { ok: true; userId: string } | { ok: false };

export async function signGlanceableSnapshotCredential(input: {
  userId: string;
  secret: string;
  now?: Date;
}): Promise<string> {
  const { token } = await signKiloToken({
    userId: input.userId,
    secret: input.secret,
    expiresInSeconds: GLANCEABLE_SNAPSHOT_CREDENTIAL_TTL_SECONDS,
    audience: GLANCEABLE_SNAPSHOT_AUDIENCE,
    now: input.now ?? new Date(),
  });
  return token;
}

export async function verifyGlanceableSnapshotCredential(input: {
  token: string;
  secret: string;
}): Promise<GlanceableSnapshotCredentialVerification> {
  try {
    const payload = await verifyKiloToken(input.token, input.secret, {
      audience: GLANCEABLE_SNAPSHOT_AUDIENCE,
    });
    return { ok: true, userId: payload.kiloUserId };
  } catch {
    return { ok: false };
  }
}
