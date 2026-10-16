import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
  WORKTREE_STATE_GRANT_SECONDS,
  worktreeStateIdentitySchema,
  type WorktreeStateIdentity,
} from '../shared/worktree-state.js';

const audience = 'cloud-agent-worktree-state';
const grantSchema = z
  .object({
    type: z.literal('worktree_state'),
    aud: z.literal(audience),
    identity: worktreeStateIdentitySchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export function mintWorktreeStateGrant(identity: WorktreeStateIdentity, secret: string): string {
  return jwt.sign(
    { type: 'worktree_state', identity: worktreeStateIdentitySchema.parse(identity) },
    secret,
    { algorithm: 'HS256', audience, expiresIn: WORKTREE_STATE_GRANT_SECONDS }
  );
}

export function validateWorktreeStateGrant(
  authorization: string | null,
  secret: string | null
): WorktreeStateIdentity | undefined {
  if (!secret || !authorization || authorization.length > 4096) return undefined;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) return undefined;
  try {
    const parsed = grantSchema.safeParse(
      jwt.verify(match[1], secret, { algorithms: ['HS256'], audience })
    );
    if (!parsed.success) return undefined;
    const { iat, exp, identity } = parsed.data;
    if (exp <= iat || exp - iat > WORKTREE_STATE_GRANT_SECONDS || iat > Date.now() / 1000 + 30) {
      return undefined;
    }
    return identity;
  } catch {
    return undefined;
  }
}
