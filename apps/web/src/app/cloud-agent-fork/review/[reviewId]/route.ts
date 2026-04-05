import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createCallerFactory, createTRPCContext } from '@/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

const createCaller = createCallerFactory(rootRouter);

type RouteContext = {
  params: Promise<{ reviewId: string }>;
};

/**
 * Fork a code review session and redirect to cloud chat.
 * This route:
 * 1. Validates the reviewId is a valid UUID
 * 2. Calls forkForReview to create a new session from the review's CLI session
 * 3. Redirects to /cloud/chat (or org variant) with the new session ID
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const url = new URL(request.url);
  const { reviewId } = await context.params;

  // Validate UUID format
  const parseResult = z.uuid().safeParse(reviewId);
  if (!parseResult.success) {
    return NextResponse.redirect(new URL('/code-reviews?error=invalid_review_id', url.origin));
  }

  try {
    const ctx = await createTRPCContext();
    const caller = createCaller(ctx);

    // Use the forkForReview procedure which handles:
    // - Review access validation (personal or org)
    // - CLI session lookup from review
    // - Blob copying
    // - New session creation with correct org context
    const newSession = await caller.cliSessions.forkForReview({
      review_id: reviewId,
      created_on_platform: 'cloud-web-review-fix',
    });

    // Redirect to cloud chat with new session
    // Use org path if session belongs to an org
    const basePath = newSession.organization_id
      ? `/organizations/${newSession.organization_id}/cloud/chat`
      : '/cloud/chat';

    return NextResponse.redirect(
      new URL(`${basePath}?sessionId=${newSession.session_id}`, url.origin)
    );
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === 'UNAUTHORIZED') {
        const signInUrl = new URL('/users/sign_in', url.origin);
        signInUrl.searchParams.set('callbackPath', `/cloud-agent-fork/review/${reviewId}`);
        return NextResponse.redirect(signInUrl);
      }
      if (error.code === 'NOT_FOUND') {
        return NextResponse.redirect(new URL('/code-reviews?error=session_not_found', url.origin));
      }
      if (error.code === 'FORBIDDEN') {
        return NextResponse.redirect(new URL('/code-reviews?error=access_denied', url.origin));
      }
    }
    return NextResponse.redirect(new URL('/code-reviews?error=fork_failed', url.origin));
  }
}
