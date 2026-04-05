import { db } from '@/lib/drizzle';
import { sql, eq, and, isNull } from 'drizzle-orm';
import { magic_link_tokens } from '@kilocode/db/schema';
import * as z from 'zod';
import 'server-only';
import { NEXTAUTH_URL } from '@/lib/config.server';
import { randomBytes, createHash } from 'crypto';

export type MagicLinkToken = z.infer<typeof MagicLinkToken>;
export const MagicLinkToken = z.object({
  token_hash: z.string(),
  email: z.string().email(),
  expires_at: z.string(),
  consumed_at: z.string().nullable(),
  created_at: z.string(),
});

export type MagicLinkTokenWithPlaintext = z.infer<typeof MagicLinkTokenWithPlaintext>;
export const MagicLinkTokenWithPlaintext = MagicLinkToken.extend({
  plaintext_token: z.string(),
});

/**
 * Generate a new magic link token using Node's crypto module.
 * The token is generated in JS and the hash is stored in the database.
 *
 * @param email - The email address to associate with the token
 * @param expiresInMinutes - Number of minutes until the token expires (default: 30)
 * @returns The created token record with the plaintext token (for sending in email)
 */
export async function createMagicLinkToken(
  email: string,
  expiresInMinutes: number = 30
): Promise<MagicLinkTokenWithPlaintext> {
  const plaintext_token = randomBytes(32).toString('hex');
  const token_hash = createHash('sha256').update(plaintext_token).digest('hex');
  const expires_at = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();

  const [inserted] = await db
    .insert(magic_link_tokens)
    .values({ token_hash, email, expires_at })
    .returning();

  if (!inserted) {
    throw new Error('Failed to create magic link token');
  }

  return MagicLinkTokenWithPlaintext.parse({ ...inserted, plaintext_token });
}

/**
 * Verify and consume a magic link token atomically.
 * This function will only succeed if the token:
 * - Exists in the database
 * - Has not been consumed yet
 * - Has not expired
 *
 * If successful, the token is marked as consumed and cannot be used again.
 *
 * @param plaintextToken - The plaintext token from the magic link URL
 * @returns The token record if valid and consumed, null otherwise
 */
export async function verifyAndConsumeMagicLinkToken(
  plaintextToken: string
): Promise<MagicLinkToken | null> {
  const token_hash = createHash('sha256').update(plaintextToken).digest('hex');

  const result = await db
    .update(magic_link_tokens)
    .set({ consumed_at: sql`NOW()` })
    .where(
      and(
        eq(magic_link_tokens.token_hash, token_hash),
        isNull(magic_link_tokens.consumed_at),
        sql`${magic_link_tokens.expires_at} > NOW()`
      )
    )
    .returning();

  if (!result[0]) {
    return null;
  }

  return MagicLinkToken.parse(result[0]);
}

export function getMagicLinkUrl(
  { plaintext_token, email }: MagicLinkTokenWithPlaintext,
  callbackUrl?: string
): string {
  const url = new URL(`${NEXTAUTH_URL}/auth/verify-magic-link`);
  url.searchParams.set('token', plaintext_token);
  url.searchParams.set('email', email);
  if (callbackUrl) {
    url.searchParams.set('callbackUrl', callbackUrl);
  }
  return url.toString();
}
