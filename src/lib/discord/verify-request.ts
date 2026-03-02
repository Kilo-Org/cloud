import 'server-only';
import { verifyKey } from 'discord-interactions';

/**
 * Verify a Discord interaction request using Ed25519 signature verification.
 * Discord sends a signature and timestamp in the headers that must be verified
 * against the raw request body using the application's public key.
 *
 * @param rawBody - The raw request body as a string
 * @param signature - The x-signature-ed25519 header value
 * @param timestamp - The x-signature-timestamp header value
 * @param publicKey - The Discord application public key
 * @returns true if the request is valid
 */
export async function verifyDiscordRequest(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKey: string
): Promise<boolean> {
  if (!signature || !timestamp) {
    return false;
  }

  // Reject requests older than 5 minutes to prevent replay attacks
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 60 * 5) {
    console.warn(
      '[Discord] Request timestamp too old or too far in the future, possible replay attack'
    );
    return false;
  }

  return verifyKey(rawBody, signature, timestamp, publicKey);
}
