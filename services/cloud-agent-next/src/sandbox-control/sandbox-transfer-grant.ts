import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
  CONTROL_LOG_GRANT_AUDIENCE,
  CONTROL_LOG_GRANT_SECONDS,
  SANDBOX_TRANSFER_GRANT_AUDIENCE,
  SANDBOX_TRANSFER_GRANT_SECONDS,
  controlLogIdentitySchema,
  sandboxTransferScopeSchema,
  sandboxTransferScopes,
  type ControlLogIdentity,
  type SandboxTransferScope,
} from '../shared/control-diagnostics.js';

const maximumAuthorizationLength = 4096;

const transferGrantSchema = z
  .object({
    type: z.literal('sandbox_transfer'),
    aud: z.literal(SANDBOX_TRANSFER_GRANT_AUDIENCE),
    identity: controlLogIdentitySchema,
    scopes: z.array(sandboxTransferScopeSchema).min(1).max(sandboxTransferScopes.length),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

const legacyGrantSchema = z
  .object({
    type: z.literal('control_log_upload'),
    aud: z.literal(CONTROL_LOG_GRANT_AUDIENCE),
    identity: controlLogIdentitySchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export type SandboxTransferGrant = {
  identity: ControlLogIdentity;
  scopes: readonly SandboxTransferScope[];
  expiresAt: number;
};

export type MintedSandboxTransferGrant = {
  grant: string;
  expiresAt: number;
};

export function mintSandboxTransferGrant(
  identity: ControlLogIdentity,
  scopes: readonly SandboxTransferScope[],
  secret: string
): MintedSandboxTransferGrant {
  const grant = jwt.sign(
    {
      type: 'sandbox_transfer',
      identity: controlLogIdentitySchema.parse(identity),
      scopes: z
        .array(sandboxTransferScopeSchema)
        .min(1)
        .max(sandboxTransferScopes.length)
        .parse(scopes),
    },
    secret,
    {
      algorithm: 'HS256',
      audience: SANDBOX_TRANSFER_GRANT_AUDIENCE,
      expiresIn: SANDBOX_TRANSFER_GRANT_SECONDS,
    }
  );
  const decoded = jwt.decode(grant) as { exp?: unknown } | null;
  const expiresAt =
    typeof decoded?.exp === 'number'
      ? decoded.exp * 1000
      : Date.now() + SANDBOX_TRANSFER_GRANT_SECONDS * 1000;
  return { grant, expiresAt };
}

export function validateSandboxTransferGrant(
  authorization: string | null,
  secret: string | null
): SandboxTransferGrant | undefined {
  if (!secret || !authorization || authorization.length > maximumAuthorizationLength)
    return undefined;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) return undefined;
  try {
    const parsed = transferGrantSchema.safeParse(
      jwt.verify(match[1], secret, {
        algorithms: ['HS256'],
        audience: SANDBOX_TRANSFER_GRANT_AUDIENCE,
      })
    );
    if (!parsed.success) return undefined;
    const { iat, exp, identity, scopes } = parsed.data;
    if (exp <= iat || exp - iat > SANDBOX_TRANSFER_GRANT_SECONDS || iat > Date.now() / 1000 + 30) {
      return undefined;
    }
    return { identity, scopes, expiresAt: exp * 1000 };
  } catch {
    return undefined;
  }
}

/**
 * Grants minted before the transfer channel existed. Log routes accept them
 * until older wrapper releases age out; artifact routes never do.
 */
export function mintControlLogUploadGrant(identity: ControlLogIdentity, secret: string): string {
  return jwt.sign(
    { type: 'control_log_upload', identity: controlLogIdentitySchema.parse(identity) },
    secret,
    {
      algorithm: 'HS256',
      audience: CONTROL_LOG_GRANT_AUDIENCE,
      expiresIn: CONTROL_LOG_GRANT_SECONDS,
    }
  );
}

export function validateControlLogUploadGrant(
  authorization: string | null,
  secret: string | null
): ControlLogIdentity | undefined {
  if (!secret || !authorization || authorization.length > maximumAuthorizationLength)
    return undefined;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) return undefined;
  try {
    const parsed = legacyGrantSchema.safeParse(
      jwt.verify(match[1], secret, {
        algorithms: ['HS256'],
        audience: CONTROL_LOG_GRANT_AUDIENCE,
      })
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
