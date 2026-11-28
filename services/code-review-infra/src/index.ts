/**
 * Code Review Worker - HTTP API
 *
 * HTTP API that receives code review requests and creates Durable Objects
 * to manage the review lifecycle.
 *
 * Architecture:
 * - POST /review - Create and start a code review (returns 202 immediately)
 * - GET /reviews/:reviewId/status - Read a review's status
 * - POST /reviews/:reviewId/cancel - Cancel a running review
 * - POST /reviews/:reviewId/retry-fresh - Retry a review on a fresh session
 * - GET /health - Health check endpoint
 *
 * Every route needs web's credential (`src/backend-auth.ts`): the `BACKEND_AUTH_TOKEN` bearer, or
 * under `BACKEND_CREDENTIAL_ACCEPT` an STS service token for the route's scope.
 *
 * Features:
 * - Durable Objects dispatch Cloud Agent Next sessions with callback completion
 * - Concurrency control handled in Next.js (dispatch logic)
 * - Fire-and-forget from Next.js dispatch
 */

import { Hono, type Context } from 'hono';
import type { Env, CodeReviewRequest, CodeReviewResponse } from './types';
import { withDORetry, createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { doNameForAttempt } from './do-name';
import { readCodeReviewInfraSecret } from './secrets';
import {
  REVIEW_ROUTES,
  RESOURCE_METADATA_PATH,
  createBackendAuth,
  protectedResourceMetadata,
} from './backend-auth';

// Import base Durable Object
import {
  CodeReviewOrchestrator as CodeReviewOrchestratorBase,
  isBitbucketCloudReviewSessionInput,
} from './code-review-orchestrator';

// Export Durable Object (with Sentry instrumentation in production)
export const CodeReviewOrchestrator = CodeReviewOrchestratorBase;

// Create Hono app with Env type
type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

/**
 * Hono's `executionCtx` getter throws outside a request context, which is how unit tests call the
 * routes. A missing context only costs the `waitUntil` keep-alive for a bundle revalidation; it
 * never changes which secret a read returns.
 */
function requestContext(c: {
  executionCtx: SecretsExecutionContext;
}): SecretsExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

// The RFC 9728 document the STS challenge names, served only while an STS mode is configured;
// otherwise the path falls through to the guard and the not-found handler, as any unmatched path.
app.get(
  RESOURCE_METADATA_PATH,
  async (c, next) => protectedResourceMetadata(c.env) ?? (await next())
);

// Authentication middleware. A failed secret read leaves the token undefined, which the middleware
// already answers 401: a missing `BACKEND_AUTH_TOKEN` was a 401 before this switch and stays one.
// The failure is logged so an unavailable secret source is distinguishable from a wrong token; the
// error names the secret, never a value.
app.use(
  '*',
  createBackendAuth<HonoEnv>(c =>
    readCodeReviewInfraSecret(c.env, 'BACKEND_AUTH_TOKEN', requestContext(c)).catch(error => {
      // Name only: an outage means one line per request, and the name is enough to tell an outage
      // from a bad token. The error's message names the secret, never its value.
      console.warn(
        '[CodeReviewWorker] BACKEND_AUTH_TOKEN unavailable',
        error instanceof Error ? error.name : 'unknown'
      );
      return undefined;
    })
  )
);

// Route: POST /review
app.post(REVIEW_ROUTES.dispatch.path, async (c: Context<HonoEnv>) => {
  let body: CodeReviewRequest;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!body.reviewId || !body.authToken || !body.sessionInput || !body.owner) {
    return c.json(
      {
        error: 'Missing required fields: reviewId, authToken, sessionInput, owner',
      },
      400
    );
  }

  if (
    body.sessionInput.platform === 'bitbucket' &&
    (!isBitbucketCloudReviewSessionInput(body.sessionInput) ||
      body.owner.type !== 'org' ||
      body.owner.id !== body.sessionInput.kilocodeOrganizationId ||
      body.sessionInput.gitToken !== undefined)
  ) {
    return c.json({ error: 'Invalid Bitbucket review request' }, 400);
  }

  console.log('[POST /review] Received review request', {
    reviewId: body.reviewId,
    owner: body.owner,
  });

  // Create DO name from reviewId (concurrency controlled by Next.js dispatch)
  const doName = doNameForAttempt(body.reviewId, body.attemptId);

  console.log('[POST /review] Creating DO', {
    reviewId: body.reviewId,
    doName,
  });

  // Get Durable Object ID
  const id = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(doName);

  // Start the review via RPC with retry (saves state, returns immediately)
  const result = await withDORetry(
    () => c.env.CODE_REVIEW_ORCHESTRATOR.get(id),
    stub =>
      stub.start({
        reviewId: body.reviewId,
        attemptId: body.attemptId,
        authToken: body.authToken,
        sessionInput: body.sessionInput,
        owner: body.owner,
        skipBalanceCheck: body.skipBalanceCheck,
        previousCloudAgentSessionId: body.previousCloudAgentSessionId,
        repositorySize: body.repositorySize,
        reviewAgents: body.reviewAgents,
      }),
    'start'
  );

  // Fire-and-forget: trigger review execution via HTTP context (no 15-min wall time limit)
  c.executionCtx.waitUntil(
    withDORetry(
      () => c.env.CODE_REVIEW_ORCHESTRATOR.get(id),
      stub => stub.runReview(),
      'runReview'
    ).catch((error: Error) => {
      console.error('[POST /review] runReview failed:', {
        reviewId: body.reviewId,
        error: error.message,
      });
    })
  );

  console.log('[POST /review] Review started', {
    reviewId: body.reviewId,
    owner: body.owner,
    status: result.status,
  });

  // Return 202 Accepted with review details
  const response: CodeReviewResponse = {
    reviewId: body.reviewId,
    attemptId: body.attemptId,
    status: result.status,
  };

  return c.json(response, 202);
});

// Route: GET /reviews/:reviewId/status
app.get(REVIEW_ROUTES.statusRead.path, async (c: Context<HonoEnv>) => {
  const reviewId = c.req.param('reviewId');
  const attemptId = c.req.query('attemptId') ?? undefined;

  if (!reviewId) {
    return c.json({ error: 'reviewId parameter required' }, 400);
  }

  console.log('[GET /reviews/:reviewId/status] Fetching status', { reviewId });

  const id = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(doNameForAttempt(reviewId, attemptId));

  const result = await withDORetry(
    () => c.env.CODE_REVIEW_ORCHESTRATOR.get(id),
    stub => stub.getStatus(),
    'getStatus'
  );

  if (!result) {
    return c.json({ error: 'Review not found' }, 404);
  }

  return c.json(result);
});

// Route: POST /reviews/:reviewId/cancel
app.post(REVIEW_ROUTES.cancel.path, async (c: Context<HonoEnv>) => {
  const reviewId = c.req.param('reviewId');

  if (!reviewId) {
    return c.json({ error: 'reviewId parameter required' }, 400);
  }

  let body: { reason?: string; attemptId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const reason = body.reason;
  const attemptId = c.req.query('attemptId') ?? body.attemptId;

  console.log('[POST /reviews/:reviewId/cancel] Cancelling review', { reviewId, reason });

  // Get Durable Object ID
  const id = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(doNameForAttempt(reviewId, attemptId));

  // Cancel via RPC with retry
  const result = await withDORetry(
    () => c.env.CODE_REVIEW_ORCHESTRATOR.get(id),
    stub => stub.cancel(reason),
    'cancel'
  );

  return c.json({ success: result, reviewId });
});

// Route: POST /reviews/:reviewId/retry-fresh
app.post(REVIEW_ROUTES.retryFresh.path, async (c: Context<HonoEnv>) => {
  const reviewId = c.req.param('reviewId');

  if (!reviewId) {
    return c.json({ error: 'reviewId parameter required' }, 400);
  }

  let body: {
    sessionId?: string;
    reason?: string;
    failedAttemptId?: string;
    retryAttemptId?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const reason = body.reason;
  if (!reason) {
    return c.json({ error: 'Missing required field: reason' }, 400);
  }

  console.log('[POST /reviews/:reviewId/retry-fresh] Retrying review with fresh session', {
    reviewId,
    reason,
    sessionId: body.sessionId,
  });

  const failedId = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(
    doNameForAttempt(reviewId, body.failedAttemptId)
  );
  const result = await withDORetry(
    () => c.env.CODE_REVIEW_ORCHESTRATOR.get(failedId),
    stub =>
      stub.retryFreshAfterInfraFailure({
        sessionId: body.sessionId,
        reason,
        retryAttemptId: body.retryAttemptId,
      }),
    'retryFreshAfterInfraFailure'
  );

  return c.json({ success: result, reviewId });
});

// Health check endpoint
app.get('/health', (c: Context<HonoEnv>) => {
  return c.json({ status: 'ok', service: 'code-review-worker' });
});

// Global error handler
app.onError(createErrorHandler());

// 404 handler
app.notFound(createNotFoundHandler());

export default app;
