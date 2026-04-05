import * as jwt from 'jsonwebtoken';
import type { PasswordRecord } from './password';

export type JwtPayload = {
  worker: string;
  passwordSetAt: number;
};

export function signJwt(
  payload: JwtPayload,
  secret: string,
  sessionDurationSeconds: number
): string {
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn: sessionDurationSeconds,
  });
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    // Validate expected fields exist
    if (typeof payload === 'object' && 'worker' in payload && 'passwordSetAt' in payload) {
      return payload as JwtPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validates an auth cookie JWT against the password record.
 * Returns true if the cookie is valid and matches the current password.
 */
export function validateAuthCookie(
  authCookie: string | undefined,
  jwtSecret: string,
  workerName: string,
  passwordRecord: PasswordRecord | null
): boolean {
  if (!authCookie) {
    return false;
  }

  const payload = verifyJwt(authCookie, jwtSecret);

  if (!payload) {
    return false;
  }

  if (payload.worker !== workerName) {
    return false;
  }

  if (!passwordRecord) {
    return false;
  }

  return payload.passwordSetAt === passwordRecord.createdAt;
}
