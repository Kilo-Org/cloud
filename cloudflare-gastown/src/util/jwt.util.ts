import jwt from 'jsonwebtoken';
import { z } from 'zod';

export const AgentJWTPayload = z.object({
  agentId: z.string(),
  rigId: z.string(),
  townId: z.string(),
  userId: z.string(),
});

export type AgentJWTPayload = z.infer<typeof AgentJWTPayload>;

export function verifyAgentJWT(
  token: string,
  secret: string
): { success: true; payload: AgentJWTPayload } | { success: false; error: string } {
  try {
    const raw = jwt.verify(token, secret, { algorithms: ['HS256'], maxAge: '24h' });
    const parsed = AgentJWTPayload.safeParse(raw);
    if (!parsed.success) {
      return { success: false, error: 'Invalid token payload' };
    }
    return { success: true, payload: parsed.data };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { success: false, error: 'Token expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return { success: false, error: 'Invalid token signature' };
    }
    return { success: false, error: 'Token validation failed' };
  }
}

export function signAgentJWT(
  payload: AgentJWTPayload,
  secret: string,
  expiresInSeconds: number = 3600
): string {
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn: expiresInSeconds,
  });
}
