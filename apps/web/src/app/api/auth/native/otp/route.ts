import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createSignInCode } from '@/lib/auth/magic-link-tokens';
import { sendSignInCodeEmail } from '@/lib/email';
import * as z from 'zod';
import { checkEmailSignInEligibility } from '@/lib/auth/email-signin-eligibility';

const requestSchema = z.object({
  email: z.string().email(),
});

/**
 * API route to request an email sign-in code for native mobile sign-in.
 * Validates eligibility, issues a 6-digit code, and emails it.
 *
 * The response is identical (200 { success: true }) whether or not a user
 * exists for the email, to avoid leaking account existence.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const validation = requestSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json({ success: false, error: 'Invalid request data' }, { status: 400 });
  }

  const { email } = validation.data;

  const eligibility = await checkEmailSignInEligibility(email, request);
  if (!eligibility.ok) {
    return NextResponse.json(eligibility.body, { status: eligibility.status });
  }

  const code = await createSignInCode(email);
  await sendSignInCodeEmail(email, code);

  return NextResponse.json({ success: true });
}
