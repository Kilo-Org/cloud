import 'server-only';
import { db } from '@/lib/drizzle';
import { kiloclaw_access_codes } from '@/db/schema';
import { eq, and, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

const CODE_LENGTH = 10;
const CODE_EXPIRATION_MINUTES = 10;

// Unambiguous characters — no 0/O/1/I
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const buf = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < buf.length; i++) {
    code += CODE_CHARS[buf[i] % CODE_CHARS.length];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Generate a new access code for a user.
 * Expires all previous active codes for this user (only one valid code at a time).
 */
export async function generateAccessCode(
  userId: string
): Promise<{ code: string; expiresAt: Date }> {
  // Expire all existing active codes for this user
  await db
    .update(kiloclaw_access_codes)
    .set({ status: 'expired' })
    .where(
      and(
        eq(kiloclaw_access_codes.kilo_user_id, userId),
        eq(kiloclaw_access_codes.status, 'active')
      )
    );

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRATION_MINUTES * 60 * 1000);

  await db.insert(kiloclaw_access_codes).values({
    code,
    kilo_user_id: userId,
    status: 'active',
    expires_at: expiresAt.toISOString(),
  });

  return { code, expiresAt };
}

/**
 * Clean up expired access codes. Called by cron.
 */
export async function cleanupExpiredAccessCodes(): Promise<number> {
  const result = await db
    .delete(kiloclaw_access_codes)
    .where(lt(kiloclaw_access_codes.expires_at, new Date().toISOString()))
    .returning({ id: kiloclaw_access_codes.id });

  return result.length;
}
