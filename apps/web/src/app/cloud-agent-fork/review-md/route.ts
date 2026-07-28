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
import {
  CODE_REVIEW_MD_CONVERSION_FLAG,
  DEFAULT_CODE_REVIEW_MODE,
  REVIEW_MD_CONVERSION_RATE_LIMIT,
  REVIEW_MD_CONVERSION_RATE_WINDOW_SECONDS,
} from '@/lib/code-reviews/core/constants';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import { buildReviewMdConversionPrompt } from '@/lib/code-reviews/prompts/review-md-conversion-prompt';
import { isFeatureFlagEnabledOrDevelopment } from '@/lib/posthog-feature-flags';
import { redisClient } from '@/lib/redis';
import { buildAllowedRepositoryFullNames } from '@/lib/code-reviews/core/selectable-repositories';

const createCaller = createCallerFactory(rootRouter);

const QuerySchema = z.object({
  platform: z.enum(['github', 'gitlab']),
  // Same shapes prepareSession accepts: "owner/repo" for GitHub, and a
  // (possibly nested) group path for GitLab.
  repo: z
    .string()
    .min(1)
    .max(511)
    .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/, 'Invalid repository path')
    // Reject `.`/`..` path segments so a shape-valid value can't smuggle traversal.
    .refine(
      value => value.split('/').every(segment => segment !== '.' && segment !== '..'),
      'Invalid repository path'
    ),
  organizationId: z.uuid().optional(),
});

/**
 * Per-actor abuse cap: a Redis fixed window keyed by the acting USER (scoped by org, so one member
 * cannot drain a shared bucket for co-members) and by the window bucket. Embedding the bucket in the
 * key makes the window self-healing: even if `expire` fails after `incr`, the key rotates on the
 * next window rather than counting up forever. Fails OPEN on any Redis error (per redis.ts guidance).
 * Callers MUST invoke this only after membership is proven, so an unauthorized org id can never
 * touch that org's counter.
 */
async function isConversionRateLimited(ownerScope: string, userId: string): Promise<boolean> {
  try {
    const windowMs = REVIEW_MD_CONVERSION_RATE_WINDOW_SECONDS * 1000;
    const bucket = Math.floor(Date.now() / windowMs);
    const key = `review-md-conversion:${ownerScope}:${userId}:${bucket}`;
    const count = await redisClient.incr(key);
    if (count === 1) {
      // Best-effort TTL cleanup; correctness does not depend on it (the key rotates per window).
      await redisClient.expire(key, REVIEW_MD_CONVERSION_RATE_WINDOW_SECONDS * 2);
    }
    return count > REVIEW_MD_CONVERSION_RATE_LIMIT;
  } catch {
    return false;
  }
}

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

  // CSRF defense for this mutating, credit-spending GET. Fail CLOSED: allow only same-origin dialog
  // clicks (`same-origin`/`same-site`) and deliberate direct navigation (`none`, e.g. typing the URL
  // or a bookmark). A `cross-site` value OR a MISSING header (older browsers, embedded webviews,
  // header-stripping proxies) is rejected, since a forged top-level navigation carries the session
  // cookie and would otherwise start a billable session.
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite !== 'same-origin' && secFetchSite !== 'same-site' && secFetchSite !== 'none') {
    return redirectToError(organizationId, 'invalid_conversion_request');
  }

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

  const userId = ctx.user?.id;
  if (!userId) {
    return redirectToError(organizationId, 'conversion_session_failed');
  }

  // Staged rollout + kill switch for this credit-spending flow (`...OrDevelopment` is always on
  // locally). The UI button reads the same flag; this is the enforcing check.
  if (!(await isFeatureFlagEnabledOrDevelopment(CODE_REVIEW_MD_CONVERSION_FLAG, userId))) {
    return redirectToError(organizationId, 'conversion_not_available');
  }

  try {
    // Reading through the same org-scoped procedure the settings page uses means
    // membership is enforced here for free — a non-member never reaches
    // prepareSession.
    const config = organizationId
      ? await caller.organizations.reviewAgent.getReviewConfig({ organizationId, platform })
      : await caller.personalReviewAgent.getReviewConfig({ platform });

    // Abuse cap — AFTER membership is proven above, so an arbitrary org UUID can't touch that org's
    // counter. Keyed per-user within the org scope; enforced regardless of model/credits since
    // free-model sessions otherwise skip balance backpressure.
    if (await isConversionRateLimited(organizationId ?? 'personal', userId)) {
      return redirectToError(organizationId, 'conversion_rate_limited');
    }

    // Authorize the repo: it must be one the caller's integration actually exposes (the same list
    // the dialog is built from). The worker enforces installation scope as well, but validating
    // here fails fast and avoids creating a billable session for a repo the caller can't target.
    const repositoryList = organizationId
      ? platform === 'gitlab'
        ? await caller.organizations.reviewAgent.listGitLabRepositories({
            organizationId,
            forceRefresh: false,
          })
        : await caller.organizations.reviewAgent.listGitHubRepositories({
            organizationId,
            forceRefresh: false,
          })
      : platform === 'gitlab'
        ? await caller.personalReviewAgent.listGitLabRepositories({ forceRefresh: false })
        : await caller.personalReviewAgent.listGitHubRepositories({ forceRefresh: false });

    const allowedRepoFullNames = buildAllowedRepositoryFullNames(
      repositoryList.repositories,
      config.manuallyAddedRepositories ?? []
    );
    if (!allowedRepoFullNames.has(repo)) {
      return redirectToError(organizationId, 'repository_not_allowed');
    }

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
        // Unguessable marker token so the untrusted instructions cannot close their own block.
        nonce: crypto.randomUUID(),
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
