import { NextResponse } from 'next/server';
import * as z from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { magic_link_tokens } from '@kilocode/db/schema';
import {
  commitSignInCode,
  consumeSignInCode,
  createMagicLinkToken,
  releaseSignInCode,
  reserveSignInCode,
  SIGN_IN_CODE_MAX_ATTEMPTS,
} from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { checkDomainSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import {
  clearPendingLinkCookie,
  completePendingLink,
  getPendingLinkBySecret,
  readPendingLinkSecret,
} from '@/lib/auth/pending-link';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { isSameOrigin } from '@/lib/auth/same-origin';

const bodySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

async function attemptsLeft(challengeId: string | null): Promise<number | undefined> {
  if (!challengeId) return undefined;
  const [row] = await db
    .select({ attempts: magic_link_tokens.attempts, legacy: magic_link_tokens.legacy_attempts })
    .from(magic_link_tokens)
    .where(eq(magic_link_tokens.challenge_id, challengeId))
    .limit(1);
  if (!row) return undefined;
  return Math.max(0, SIGN_IN_CODE_MAX_ATTEMPTS - row.attempts - row.legacy);
}

export const POST = withRestTiming('/api/auth/pending-link/verify', async (request: Request) => {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
  }
  const body: unknown = await request.json().catch(() => undefined);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  const secret = await readPendingLinkSecret();
  const row = secret ? await getPendingLinkBySecret(secret) : null;
  if (!secret || !row) {
    return NextResponse.json({ error: 'EXPIRED' }, { status: 404 });
  }
  if (!row.email_code_allowed) {
    return NextResponse.json({ error: 'EMAIL_CODE_NOT_ALLOWED' }, { status: 403 });
  }

  const user = await findUserById(row.kilo_user_id);
  if (!user) {
    return NextResponse.json({ error: 'EXPIRED' }, { status: 404 });
  }
  if (user.blocked_reason) {
    return NextResponse.json({ error: 'BLOCKED' }, { status: 403 });
  }
  const eligibility = await checkDomainSignInEligibility(user.google_user_email);
  if (!eligibility.ok) {
    return NextResponse.json({ error: eligibility.errorCode }, { status: eligibility.status });
  }

  if (!row.email_code_challenge_id) {
    return NextResponse.json({ error: 'CODE_NOT_REQUESTED' }, { status: 409 });
  }
  const challengeId = row.email_code_challenge_id;
  const reserve = await reserveSignInCode(user.google_user_email, parsed.data.code, challengeId);
  if (reserve === 'invalid') {
    return NextResponse.json(
      { error: 'INVALID_CODE', attemptsLeft: await attemptsLeft(row.email_code_challenge_id) },
      { status: 401 }
    );
  }
  if (reserve === 'too_many_attempts') {
    return NextResponse.json({ error: 'TOO_MANY_ATTEMPTS' }, { status: 429 });
  }
  if (reserve === 'in_progress') {
    return NextResponse.json({ error: 'CODE_IN_PROGRESS' }, { status: 425 });
  }

  const completed = await completePendingLink(secret, row.kilo_user_id);
  if (completed.status === 'failed') {
    await releaseSignInCode(user.google_user_email, parsed.data.code, challengeId);
    if (completed.reason === 'EXPIRED') {
      return NextResponse.json({ error: 'EXPIRED' }, { status: 404 });
    }
    return NextResponse.json({ error: completed.reason }, { status: 403 });
  }

  const committed = await commitSignInCode(user.google_user_email, parsed.data.code, challengeId);
  if (!committed) {
    await consumeSignInCode(user.google_user_email, parsed.data.code, challengeId);
  }

  const magicLink = await createMagicLinkToken(user.google_user_email);
  await clearPendingLinkCookie();
  const callbackUrl =
    row.callback_path && isValidCallbackPath(row.callback_path)
      ? `/users/after-sign-in?callbackPath=${encodeURIComponent(row.callback_path)}`
      : '/users/after-sign-in';
  return NextResponse.json({
    token: magicLink.plaintext_token,
    callbackUrl,
    provider: completed.provider,
  });
});
