import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
  CONTROL_LOG_GRANT_SECONDS,
  controlLogIdentitySchema,
  type ControlLogIdentity,
} from '../shared/control-diagnostics.js';

const audience = 'cloud-agent-control-log-upload';
const grantSchema = z
  .object({
    type: z.literal('control_log_upload'),
    aud: z.literal(audience),
    identity: controlLogIdentitySchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export type ControlLogUploadCredential = {
  grant: string;
  /** Wall-clock expiry in milliseconds. */
  expiresAt: number;
};

export function mintControlLogUploadCredential(
  identity: ControlLogIdentity,
  secret: string
): ControlLogUploadCredential {
  const grant = jwt.sign(
    { type: 'control_log_upload', identity: controlLogIdentitySchema.parse(identity) },
    secret,
    { algorithm: 'HS256', audience, expiresIn: CONTROL_LOG_GRANT_SECONDS }
  );
  const decoded = jwt.decode(grant);
  const expiresAt =
    typeof decoded === 'object' && decoded !== null && typeof decoded.exp === 'number'
      ? decoded.exp * 1000
      : Date.now() + CONTROL_LOG_GRANT_SECONDS * 1000;
  return { grant, expiresAt };
}

export function mintControlLogUploadGrant(identity: ControlLogIdentity, secret: string): string {
  return mintControlLogUploadCredential(identity, secret).grant;
}

export function validateControlLogUploadGrant(
  authorization: string | null,
  secret: string | null
): ControlLogIdentity | undefined {
  if (!secret || !authorization || authorization.length > 4096) return undefined;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) return undefined;
  try {
    const parsed = grantSchema.safeParse(
      jwt.verify(match[1], secret, { algorithms: ['HS256'], audience })
    );
    if (!parsed.success) return undefined;
    const { iat, exp, identity } = parsed.data;
    if (exp <= iat || exp - iat > CONTROL_LOG_GRANT_SECONDS || iat > Date.now() / 1000 + 30) {
      return undefined;
    }
    return identity;
  } catch {
    return undefined;
  }
}

/**
 * The original launch grant is an identity proof for renewal, not a bearer
 * credential. Its signature must still verify, but it may be expired: a long
 * running wrapper (or a restarted one) renews through the current authenticated
 * socket instead of the grant's own lifetime.
 */
export function validateControlLogGrantProof(
  token: string | null,
  secret: string | null
): ControlLogIdentity | undefined {
  if (!secret || !token || token.length > 4096) return undefined;
  try {
    const parsed = grantSchema.safeParse(
      jwt.verify(token, secret, { algorithms: ['HS256'], audience, ignoreExpiration: true })
    );
    if (!parsed.success) return undefined;
    const { iat, exp, identity } = parsed.data;
    if (exp <= iat || exp - iat > CONTROL_LOG_GRANT_SECONDS || iat > Date.now() / 1000 + 30) {
      return undefined;
    }
    return identity;
  } catch {
    return undefined;
  }
}

/**
 * A renewal is authorized only by the current bound socket for the same
 * allocation, plus the launch grant's signature as identity proof. The grant's
 * `wrapperInstanceId` names the launch (and therefore the upload path); it is
 * deliberately not compared with the socket's `wrapperId`.
 */
export function validateControlLogRenewal(input: {
  proof: string | null;
  secret: string | null;
  socketAuthorized: boolean;
  sandboxId: string;
  allocationId: string;
}): ControlLogIdentity | undefined {
  if (!input.socketAuthorized) return undefined;
  const identity = validateControlLogGrantProof(input.proof, input.secret);
  if (!identity) return undefined;
  if (identity.sandboxId !== input.sandboxId || identity.allocationId !== input.allocationId) {
    return undefined;
  }
  return identity;
}
