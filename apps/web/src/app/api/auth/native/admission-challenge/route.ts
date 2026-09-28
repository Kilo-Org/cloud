import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { issueAdmissionChallenge, ChallengeRateLimitError } from '@/lib/auth/native-admission';
import { withRestTiming } from '@/lib/observability/request-timing';

/**
 * POST /api/auth/native/admission-challenge
 *
 * Issues a server-side attestation challenge for the mobile client.
 *
 * Request body:
 *   { platform: 'ios' | 'android' }
 *
 * Response:
 *   200 { challenge: string, expiresIn: number }
 *   400 invalid request
 *   429 rate limited
 */
export const POST = withRestTiming(
  '/api/auth/native/admission-challenge',
  async (request: Request) => {
    const body = await request.json().catch(() => undefined);
    const validation = z.object({ platform: z.enum(['ios', 'android']) }).safeParse(body);

    if (!validation.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    // Extract client IP for rate limiting
    const ipAddress =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown';

    try {
      const result = await issueAdmissionChallenge(request as NextRequest, ipAddress);
      return NextResponse.json(result, { status: 200 });
    } catch (error) {
      if (error instanceof ChallengeRateLimitError) {
        return NextResponse.json({ error: 'TOO_MANY_CHALLENGES' }, { status: 429 });
      }
      throw error;
    }
  }
);
