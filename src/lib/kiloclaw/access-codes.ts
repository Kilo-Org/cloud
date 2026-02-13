import 'server-only';
import { db } from '@/lib/drizzle';
import { kiloclaw_access_codes } from '@/db/schema';
import { eq, and, lt, ne, or } from 'drizzle-orm';
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
 * Atomically expires all previous active codes and inserts the new one,
 * ensuring only one valid code exists per user at any time.
 */
export async function generateAccessCode(
  userId: string
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRATION_MINUTES * 60 * 1000);

  await db.transaction(async tx => {
    // Expire all existing active codes for this user
    await tx
      .update(kiloclaw_access_codes)
      .set({ status: 'expired' })
      .where(
        and(
          eq(kiloclaw_access_codes.kilo_user_id, userId),
          eq(kiloclaw_access_codes.status, 'active')
        )
      );

    await tx.insert(kiloclaw_access_codes).values({
      code,
      kilo_user_id: userId,
      status: 'active',
      expires_at: expiresAt.toISOString(),
    });
  });

  return { code, expiresAt };
}

/**
 * Clean up access codes that are expired or already consumed.
 * Called by cron — codes are validated at redemption time regardless.
 */
export async function cleanupExpiredAccessCodes(): Promise<number> {
  const result = await db
    .delete(kiloclaw_access_codes)
    .where(
      or(
        lt(kiloclaw_access_codes.expires_at, new Date().toISOString()),
        ne(kiloclaw_access_codes.status, 'active')
      )
    )
    .returning({ id: kiloclaw_access_codes.id });

  return result.length;
}
