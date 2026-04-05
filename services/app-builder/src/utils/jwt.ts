import * as jwt from 'jsonwebtoken';
import { z } from 'zod';

const gitTokenPayloadSchema = z.object({ permission: z.enum(['full', 'ro']) });

export type GitTokenPermission = z.infer<typeof gitTokenPayloadSchema>['permission'];

const ISSUER = 'app-builder';
export const DEFAULT_EXPIRY_SECONDS = 7200;

export function signGitToken(
  repoId: string,
  permission: GitTokenPermission,
  secret: string,
  expirySeconds: number = DEFAULT_EXPIRY_SECONDS
): string {
  return jwt.sign({ permission }, secret, {
    algorithm: 'HS256',
    issuer: ISSUER,
    subject: repoId,
    expiresIn: expirySeconds,
  });
}

export function verifyGitToken(
  token: string,
  repoId: string,
  secret: string
): { valid: true; permission: GitTokenPermission } | { valid: false; error: string } {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      subject: repoId,
    });

    const { permission } = gitTokenPayloadSchema.parse(payload);

    return { valid: true, permission };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { valid: false, error: 'Token expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      if (error.message.includes('subject')) {
        return { valid: false, error: 'Token not valid for this repository' };
      }
      if (error.message.includes('issuer')) {
        return { valid: false, error: 'Invalid issuer' };
      }
      return { valid: false, error: 'Invalid signature' };
    }
    return { valid: false, error: 'Invalid token format' };
  }
}
