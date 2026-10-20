import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { buildFixReviewPrompt } from '@/lib/code-reviews/prompts/fix-review-prompt';
import { selectFixReviewCommentsForReview } from '@/lib/code-reviews/fix-review/select-comments';
import { DEFAULT_CODE_REVIEW_MODE } from '@/lib/code-reviews/core/constants';
import { resolveBotModelSlug } from '@/lib/bot/model';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { createCallerFactory, createTRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

const createCaller = createCallerFactory(rootRouter);

type RouteContext = {
  params: Promise<{ reviewId: string }>;
};

function redirectToError(origin: string, error: string) {
  return NextResponse.redirect(new URL(`/code-reviews?error=${error}`, origin));
}

export async function GET(request: NextRequest, context: RouteContext) {
  const url = new URL(request.url);
  const { reviewId } = await context.params;

  const parseResult = z.uuid().safeParse(reviewId);
  if (!parseResult.success) {
    return redirectToError(url.origin, 'invalid_review_id');
  }

  let ctx: Awaited<ReturnType<typeof createTRPCContext>>;

  try {
    ctx = await createTRPCContext();
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === 'UNAUTHORIZED') {
        const signInUrl = new URL('/users/sign_in', url.origin);
        signInUrl.searchParams.set('callbackPath', `/cloud-agent-fork/review/${reviewId}`);
        return NextResponse.redirect(signInUrl);
      }
    }
    return redirectToError(url.origin, 'fix_session_failed');
  }

  const caller = createCaller(ctx);

  let reviewResult: Awaited<ReturnType<typeof caller.codeReviews.get>>;

  try {
    reviewResult = await caller.codeReviews.get({ reviewId });
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === 'NOT_FOUND') {
        return redirectToError(url.origin, 'review_not_found');
      }
      if (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN') {
        return redirectToError(url.origin, 'access_denied');
      }
    }
    return redirectToError(url.origin, 'fix_session_failed');
  }

  if (!reviewResult.success) {
    return redirectToError(url.origin, 'fix_session_failed');
  }

  const { review } = reviewResult;

  if (review.platform !== 'github') {
    return redirectToError(url.origin, 'unsupported_platform');
  }

  try {
    const organizationId = review.owned_by_organization_id;
    const integration = review.platform_integration_id
      ? await getIntegrationById(review.platform_integration_id)
      : null;

    if (
      integration &&
      (integration.platform !== review.platform ||
        integration.owned_by_user_id !== review.owned_by_user_id ||
        integration.owned_by_organization_id !== review.owned_by_organization_id)
    ) {
      return redirectToError(url.origin, 'fix_session_failed');
    }

    const comments = await selectFixReviewCommentsForReview({
      repositoryFullName: review.repo_full_name,
      pullNumber: review.pr_number,
      prAuthor: review.pr_author,
      initiatorKiloUserId: ctx.user.id,
      integration,
    });

    const sessionInput = {
      githubRepo: review.repo_full_name,
      prompt: buildFixReviewPrompt({
        prUrl: review.pr_url,
        repositoryFullName: review.repo_full_name,
        pullNumber: review.pr_number,
        headRef: review.head_ref,
        comments,
        nonce: randomUUID(),
      }),
      mode: DEFAULT_CODE_REVIEW_MODE,
      model: resolveBotModelSlug(integration),
      autoInitiate: true,
      autoCommit: false,
    };
    const session = organizationId
      ? await caller.organizations.cloudAgentNext.prepareSession({
          ...sessionInput,
          organizationId,
        })
      : await caller.cloudAgentNext.prepareSession(sessionInput);

    const chatUrl = new URL(
      organizationId ? `/organizations/${organizationId}/cloud/chat` : '/cloud/chat',
      url.origin
    );
    chatUrl.searchParams.set('sessionId', session.kiloSessionId);

    const response = NextResponse.redirect(chatUrl, 303);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch {
    return redirectToError(url.origin, 'fix_session_failed');
  }
}
