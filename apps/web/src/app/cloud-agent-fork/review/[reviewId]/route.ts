/**
 * Starts the cloud agent session that fixes a code review's comments.
 *
 * Opening the posted link renders the confirmation page (`./confirm`), and the
 * session is prepared only from a same-origin submission of that page's form.
 *
 * The prompt is derived server side from the review row, so this endpoint
 * cannot be used to inject arbitrary prompt text into a cloud agent session.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { buildFixReviewPrompt } from '@/lib/code-reviews/prompts/fix-review-prompt';
import {
  DEFAULT_CODE_REVIEW_MODE,
  REVIEW_FIX_SESSION_RATE_LIMIT,
  REVIEW_FIX_SESSION_RATE_WINDOW_SECONDS,
} from '@/lib/code-reviews/core/constants';
import { isSessionStartRateLimited } from '@/lib/code-reviews/core/session-start-rate-limit';
import { resolveBotModelSlug } from '@/lib/bot/model';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { createCallerFactory, createTRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

const createCaller = createCallerFactory(rootRouter);

const RATE_LIMIT_KEY_PREFIX = 'review-fix-session';

type RouteContext = {
  params: Promise<{ reviewId: string }>;
};

/**
 * Redirect to a path on whatever origin the browser is actually using: the dev
 * server binds 0.0.0.0, so an absolute Location built from `request.url` would
 * drop the session cookie and bounce to sign-in.
 */
function relativeRedirect(pathWithQuery: string, status: 302 | 303 = 302) {
  return new NextResponse(null, {
    status,
    headers: { Location: pathWithQuery, 'Cache-Control': 'no-store' },
  });
}

function confirmationPath(reviewId: string): string {
  return `/cloud-agent-fork/review/${reviewId}/confirm`;
}

function redirectToError(error: string) {
  return relativeRedirect(`/code-reviews?error=${error}`);
}

/**
 * True when a submission comes from the app origin: `Origin`, which the browser
 * sends on every form POST, names the host it addressed, or `Sec-Fetch-Site`
 * reports this origin.
 */
function isSameOriginSubmission(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    return originHost === (request.headers.get('host') ?? request.nextUrl.host);
  }

  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const { reviewId } = await context.params;

  if (!z.uuid().safeParse(reviewId).success) {
    return redirectToError('invalid_review_id');
  }

  return relativeRedirect(confirmationPath(reviewId));
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { reviewId } = await context.params;

  if (!z.uuid().safeParse(reviewId).success) {
    return redirectToError('invalid_review_id');
  }

  if (!isSameOriginSubmission(request)) {
    return relativeRedirect(`${confirmationPath(reviewId)}?error=invalid_origin`, 303);
  }

  let ctx: Awaited<ReturnType<typeof createTRPCContext>>;

  try {
    ctx = await createTRPCContext();
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === 'UNAUTHORIZED') {
        const params = new URLSearchParams({
          callbackPath: confirmationPath(reviewId),
        });
        return relativeRedirect(`/users/sign_in?${params.toString()}`);
      }
    }
    return redirectToError('fix_session_failed');
  }

  const caller = createCaller(ctx);

  let reviewResult: Awaited<ReturnType<typeof caller.codeReviews.get>>;

  try {
    reviewResult = await caller.codeReviews.get({ reviewId });
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === 'NOT_FOUND') {
        return redirectToError('review_not_found');
      }
      if (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN') {
        return redirectToError('access_denied');
      }
    }
    return redirectToError('fix_session_failed');
  }

  if (!reviewResult.success) {
    return redirectToError('fix_session_failed');
  }

  const { review } = reviewResult;

  if (review.platform !== 'github') {
    return redirectToError('unsupported_platform');
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
      return redirectToError('fix_session_failed');
    }

    // Abuse cap — AFTER the review read above proved access, so an arbitrary org
    // id cannot touch that org's counter. Enforced regardless of model/credits
    // since free-model sessions otherwise skip balance backpressure.
    const rateLimited = await isSessionStartRateLimited({
      keyPrefix: RATE_LIMIT_KEY_PREFIX,
      ownerScope: organizationId ?? 'personal',
      userId: ctx.user.id,
      limit: REVIEW_FIX_SESSION_RATE_LIMIT,
      windowSeconds: REVIEW_FIX_SESSION_RATE_WINDOW_SECONDS,
    });
    if (rateLimited) {
      return relativeRedirect(`${confirmationPath(reviewId)}?error=rate_limited`, 303);
    }

    const sessionInput = {
      githubRepo: review.repo_full_name,
      prompt: buildFixReviewPrompt(review.pr_url),
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

    const chatPath = organizationId ? `/organizations/${organizationId}/cloud/chat` : '/cloud/chat';
    const params = new URLSearchParams({ sessionId: session.kiloSessionId });

    return relativeRedirect(`${chatPath}?${params.toString()}`, 303);
  } catch {
    return redirectToError('fix_session_failed');
  }
}
