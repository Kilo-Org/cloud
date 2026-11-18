import { timingSafeEqual } from '@kilocode/encryption';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { SANDBOX_ID_PATTERN } from './stub.js';

const CREDENTIAL_BYTES = 32;
const PRESENTED_CREDENTIAL_MAX_CHARS = 256;
const encoder = new TextEncoder();
const LAUNCH_CREDENTIAL_MAX_CHARS = 2048;
const LAUNCH_AUDIENCE = 'cloud-agent-control-wrapper-launch';
const launchCredentialSchema = z
  .object({
    type: z.literal('control_wrapper_launch'),
    aud: z.literal(LAUNCH_AUDIENCE),
    sandboxId: z.string().regex(SANDBOX_ID_PATTERN),
    allocationId: z.uuid(),
    credential: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function mintSandboxLaunchCredential(
  input: { sandboxId: string; allocationId: string; credential: string },
  secret: string
): string {
  return jwt.sign(
    launchCredentialSchema.parse({
      ...input,
      type: 'control_wrapper_launch',
      aud: LAUNCH_AUDIENCE,
    }),
    secret,
    { algorithm: 'HS256', noTimestamp: true }
  );
}

export function parseSandboxLaunchBearer(authorization: string | null): string | null {
  if (!authorization || authorization.length > LAUNCH_CREDENTIAL_MAX_CHARS + 7) return null;
  const match = /^Bearer (\S+)$/.exec(authorization);
  return match?.[1] && match[1].length <= LAUNCH_CREDENTIAL_MAX_CHARS ? match[1] : null;
}

export function verifySandboxLaunchCredential(token: string, secret: string) {
  if (token.length === 0 || token.length > LAUNCH_CREDENTIAL_MAX_CHARS) return null;
  try {
    const parsed = launchCredentialSchema.safeParse(
      jwt.verify(token, secret, {
        algorithms: ['HS256'],
        audience: LAUNCH_AUDIENCE,
      })
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function generateSandboxCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CREDENTIAL_BYTES));
  return bytesToHex(bytes);
}

export async function hashSandboxCredential(credential: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(credential));
  return bytesToHex(new Uint8Array(digest));
}

export async function sandboxCredentialMatchesHash(
  credential: string,
  expectedHash: string
): Promise<boolean> {
  if (credential.length === 0 || credential.length > PRESENTED_CREDENTIAL_MAX_CHARS) {
    return false;
  }
  const presentedHash = await hashSandboxCredential(credential);
  return timingSafeEqual(presentedHash, expectedHash);
}

export function parseBearerCredential(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^Bearer\s+(\S+)$/.exec(authorization);
  if (!match) return null;
  const credential = match[1];
  if (!credential || credential.length > PRESENTED_CREDENTIAL_MAX_CHARS) return null;
  return credential;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
