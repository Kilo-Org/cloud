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

export function mintControlLogUploadGrant(identity: ControlLogIdentity, secret: string): string {
  return jwt.sign(
    { type: 'control_log_upload', identity: controlLogIdentitySchema.parse(identity) },
    secret,
    { algorithm: 'HS256', audience, expiresIn: CONTROL_LOG_GRANT_SECONDS }
  );
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
