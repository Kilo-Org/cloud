/**
 * Custom Instructions -> REVIEW.md conversion (PoC).
 *
 * GET route that spawns a cloud agent session which writes REVIEW.md and opens
 * a PR/MR for one repository, then redirects the browser into that session's
 * chat. Mirrors /cloud-agent-fork/review/[reviewId], which does the same thing
 * for the "fix this review" button.
 *
 * A GET + redirect (rather than a JSON POST) keeps each conversion a real
 * navigation from a real user click, so N repositories are N link clicks and
 * never hit popup blocking. See ReviewMdConversionDialog.
 *
 * The instructions text is NOT accepted from the caller — it is read server
 * side from the same config the settings page renders, so this endpoint cannot
 * be used to inject arbitrary prompt text into a cloud agent session.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { createCallerFactory, createTRPCContext } from '@/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import { DEFAULT_CODE_REVIEW_MODE } from '@/lib/code-reviews/core/constants';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import { buildReviewMdConversionPrompt } from '@/lib/code-reviews/prompts/review-md-conversion-prompt';

const createCaller = createCallerFactory(rootRouter);

const QuerySchema = z.object({
  platform: z.enum(['github', 'gitlab']),
  // Same shapes prepareSession accepts: "owner/repo" for GitHub, and a
  // (possibly nested) group path for GitLab.
  repo: z
    .string()
    .min(1)
    .max(511)
    .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/, 'Invalid repository path'),
  organizationId: z.uuid().optional(),
});

function settingsPath(organizationId: string | undefined): string {
  return organizationId ? `/organizations/${organizationId}/code-reviews` : '/code-reviews';
}

/**
 * Redirect to a path on whatever origin the browser is actually using.
 *
 * Deliberately NOT NextResponse.redirect(new URL(path, request.url)): the dev
 * server binds 0.0.0.0 (scripts/dev.sh), so `request.url` reports an origin of
 * http://0.0.0.0:3000 even when the browser is on localhost. Redirecting there
 * is a cross-origin hop, the session cookie is not sent, and the destination
 * bounces to sign-in. A relative Location is resolved by the browser against
 * the current origin, so the session survives.
 */
function relativeRedirect(pathWithQuery: string, status: 302 | 303 = 302) {
  return new NextResponse(null, {
    status,
    headers: { Location: pathWithQuery, 'Cache-Control': 'no-store' },
  });
}

function redirectToError(organizationId: string | undefined, error: string) {
  const params = new URLSearchParams({ error });
  return relativeRedirect(`${settingsPath(organizationId)}?${params.toString()}`);
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);

  const parsed = QuerySchema.safeParse({
    platform: url.searchParams.get('platform') ?? undefined,
    repo: url.searchParams.get('repo') ?? undefined,
    organizationId: url.searchParams.get('organizationId') ?? undefined,
  });

  if (!parsed.success) {
    return redirectToError(undefined, 'invalid_conversion_request');
  }

  const { platform, repo, organizationId } = parsed.data;

  let ctx: Awaited<ReturnType<typeof createTRPCContext>>;
  try {
    ctx = await createTRPCContext();
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'UNAUTHORIZED') {
      const params = new URLSearchParams({
        callbackPath: `/cloud-agent-fork/review-md${url.search}`,
      });
      return relativeRedirect(`/users/sign_in?${params.toString()}`);
    }
    return redirectToError(organizationId, 'conversion_session_failed');
  }

  const caller = createCaller(ctx);

  try {
    // Reading through the same org-scoped procedure the settings page uses means
    // membership is enforced here for free — a non-member never reaches
    // prepareSession.
    const config = organizationId
      ? await caller.organizations.reviewAgent.getReviewConfig({ organizationId, platform })
      : await caller.personalReviewAgent.getReviewConfig({ platform });

    const customInstructions = config.customInstructions?.trim();
    if (!customInstructions) {
      return redirectToError(organizationId, 'no_custom_instructions');
    }

    const sessionInput = {
      ...(platform === 'gitlab' ? { gitlabProject: repo } : { githubRepo: repo }),
      prompt: buildReviewMdConversionPrompt({
        platform,
        repoFullName: repo,
        customInstructions,
      }),
      mode: DEFAULT_CODE_REVIEW_MODE,
      model: config.modelSlug || PRIMARY_DEFAULT_MODEL,
      // Start the turn in the same call rather than requiring a follow-up
      // initiateFromPreparedSession.
      autoInitiate: true,
      // The prompt drives its own git operations; the harness must not commit
      // anything on the agent's behalf.
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
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN') {
        return redirectToError(organizationId, 'access_denied');
      }
      if (error.code === 'PAYMENT_REQUIRED') {
        return redirectToError(organizationId, 'insufficient_credits');
      }
    }
    return redirectToError(organizationId, 'conversion_session_failed');
  }
}
