import 'server-only';
import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { z } from 'zod';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';

/**
 * The in-flight Claude billing connection, kept server side in an encrypted
 * cookie so the callback can check the `state`, redeem the code with the PKCE
 * verifier, and return the person to where they started.
 */

export const CLAUDE_BILLING_PENDING_COOKIE = 'claude_billing_pending';

/** PAR expires after ten minutes; authorization codes expire after five. */
const PENDING_LIFETIME_SECONDS = 10 * 60;

const pendingSchema = z.object({
  /** The Kilo user who started the connection; the callback must match it. */
  kiloUserId: z.string().min(1),
  /** `personal` for the person's own account, otherwise the organization ID. */
  owner: z.string().min(1),
  returnPath: z.string().startsWith('/'),
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  userProfileId: z.string().min(1),
  connectionVersion: z.string().min(1),
});

export type ClaudeBillingPending = z.infer<typeof pendingSchema>;

function encryptionKey(): Uint8Array {
  // A dedicated key derived from the session secret: the cookie is never a
  // session token, so it cannot be replayed as one.
  return createHash('sha256').update(`claude-billing-pending:${NEXTAUTH_SECRET}`).digest();
}

async function sealJwt(pending: ClaudeBillingPending): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new EncryptJWT({ pending })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt(now)
    .setExpirationTime(now + PENDING_LIFETIME_SECONDS)
    .encrypt(encryptionKey());
}

export async function saveClaudeBillingPending(pending: ClaudeBillingPending): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(CLAUDE_BILLING_PENDING_COOKIE, await sealJwt(pending), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NEXTAUTH_URL?.startsWith('https://') ?? false,
    path: '/claude/billing',
    maxAge: PENDING_LIFETIME_SECONDS,
  });
}

async function readSealedJwt(value: string): Promise<ClaudeBillingPending | null> {
  try {
    const { payload } = await jwtDecrypt(value, encryptionKey());
    const parsed = pendingSchema.safeParse(payload.pending);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Reads and clears the pending state; it is single use. */
export async function consumeClaudeBillingPending(): Promise<ClaudeBillingPending | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(CLAUDE_BILLING_PENDING_COOKIE)?.value;
  cookieStore.set(CLAUDE_BILLING_PENDING_COOKIE, '', {
    path: '/claude/billing',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NEXTAUTH_URL?.startsWith('https://') ?? false,
    maxAge: 0,
  });
  return value ? await readSealedJwt(value) : null;
}
