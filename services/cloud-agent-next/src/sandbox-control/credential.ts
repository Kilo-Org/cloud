import { timingSafeEqual } from '@kilocode/encryption';
import { bytesToHex, sha256Hex } from '@kilocode/worker-utils/sha256';

const CREDENTIAL_BYTES = 32;
const PRESENTED_CREDENTIAL_MAX_CHARS = 256;

export function generateSandboxCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CREDENTIAL_BYTES));
  return bytesToHex(bytes);
}

export async function hashSandboxCredential(credential: string): Promise<string> {
  return sha256Hex(credential);
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
