import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  createSignInCode,
  deleteSignInCode,
} from '@kilocode/web-shared/lib/auth/magic-link-tokens';
import { sendAccountLinkCodeEmail } from '@kilocode/web-shared/lib/email';
import { AUTH_PROVIDER_DISPLAY_NAMES } from '@kilocode/web-shared/lib/auth/constants';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { checkEmailSignInEligibility } from '@/lib/auth/email-signin-eligibility';
import {
  claimEmailCodeSend,
  getPendingLinkBySecret,
  readPendingLinkSecret,
  releaseEmailCodeSend,
  setPendingLinkEmailChallenge,
} from '@/lib/auth/pending-link';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { isSameOrigin } from '@/lib/auth/same-origin';

export const POST = withRestTiming(
  '/api/auth/pending-link/email-code',
  async (request: Request) => {
    if (!isSameOrigin(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
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

    const eligibility = await checkEmailSignInEligibility(
      user.google_user_email,
      request as NextRequest
    );
    if (!eligibility.ok) {
      if (eligibility.errorCode === 'SIGNUP-RATE-LIMITED') {
        return NextResponse.json(
          { error: 'RATE_LIMITED', message: 'Too many codes requested. Try again later.' },
          { status: 429 }
        );
      }
      return NextResponse.json({ error: eligibility.errorCode }, { status: eligibility.status });
    }

    if (!(await claimEmailCodeSend(secret))) {
      if (!(await getPendingLinkBySecret(secret))) {
        return NextResponse.json({ error: 'EXPIRED' }, { status: 404 });
      }
      return NextResponse.json(
        { error: 'TOO_MANY_CODES', message: 'No more codes can be sent for this request.' },
        { status: 429 }
      );
    }

    const { code, challengeId } = await createSignInCode(user.google_user_email);
    await setPendingLinkEmailChallenge(secret, challengeId);
    const result = await sendAccountLinkCodeEmail(
      user.google_user_email,
      code,
      AUTH_PROVIDER_DISPLAY_NAMES[row.provider]
    );
    if (!result.sent) {
      await releaseEmailCodeSend(secret);
      await deleteSignInCode(user.google_user_email, code);
      return NextResponse.json(
        { error: 'EMAIL_DELIVERY_FAILED', message: 'The code could not be sent. Try again.' },
        { status: 502 }
      );
    }
    return NextResponse.json({ sent: true });
  }
);
