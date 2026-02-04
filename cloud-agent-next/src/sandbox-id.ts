import type { SandboxId } from './types.js';

/**
 * Generate a deterministic, Cloudflare-compatible sandboxId (≤63 chars).
 *
 * Format: {prefix}-{hash48}
 * - prefix (3 chars): 'org'|'usr'|'bot'|'ubt'
 * - hash48 (48 chars): First 48 hex chars of SHA-256 hash
 * - Total: 52 characters
 *
 * The hash is computed from the original sandboxId format to maintain
 * determinism while reducing length.
 *
 * @param orgId - Organization ID (undefined for personal accounts)
 * @param userId - User ID (required)
 * @param botId - Bot ID (optional)
 * @returns Promise<SandboxId> - Deterministic sandboxId string (52 characters)
 *
 * @example
 * // Organization account
 * await generateSandboxId('org-uuid', 'user-uuid', undefined)
 * // => 'org-a1b2c3d4e5f6789012345678901234567890123456789012'
 *
 * @example
 * // Personal account with bot
 * await generateSandboxId(undefined, 'user-uuid', 'reviewer')
 * // => 'ubt-f7e6d5c4b3a29182736458abc123def456789fedcba987'
 */
export async function generateSandboxId(
  orgId: string | undefined,
  userId: string,
  botId?: string
): Promise<SandboxId> {
  // Build the original format string that would have been used
  const sandboxOrgSegment = orgId ?? `user:${userId}`;
  const originalFormat = botId
    ? `${sandboxOrgSegment}__${userId}__bot:${botId}`
    : `${sandboxOrgSegment}__${userId}`;

  // Determine prefix based on account type
  let prefix: string;
  if (botId) {
    prefix = orgId ? 'bot' : 'ubt'; // bot in org, or user-bot
  } else {
    prefix = orgId ? 'org' : 'usr'; // org account or user account
  }

  // Hash the original format using SHA-256
  const encoder = new TextEncoder();
  const data = encoder.encode(originalFormat);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);

  // Convert to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  // Take first 48 hex characters (192 bits of entropy)
  const hash48 = hashHex.substring(0, 48);

  // Construct final sandboxId: prefix-hash (3 + 1 + 48 = 52 chars)
  return `${prefix}-${hash48}` as SandboxId;
}
