/**
 * Code Review Worker - HTTP API
 *
 * HTTP API that receives code review requests and creates Durable Objects
 * to manage the review lifecycle.
 *
 * Architecture:
 * - POST /review - Create and start a code review (returns 202 immediately)
 * - GET /reviews/:reviewId/events - Get events for a review (SSE flow only)
 * - POST /reviews/:reviewId/cancel - Cancel a running review
 * - GET /health - Health check endpoint
 *
 * Features:
 * - Durable Objects support two execution modes (feature-flagged):
 *   - Default: cloud-agent SSE streaming (initiateSessionAsync)
 *   - cloud-agent-next: prepareSession + initiateFromKilocodeSessionV2 with callback
 * - Concurrency control handled in Next.js (dispatch logic)
 * - Fire-and-forget from Next.js dispatch
 */

import { Hono, type Context } from 'hono';
import type { Env, CodeReviewRequest, CodeReviewResponse } from './types';
import {
  withDORetry,
  backendAuthMiddleware,
  createErrorHandler,
  createNotFoundHandler,
} from '@kilocode/worker-utils';
import { doNameForAttempt } from './do-name';

// Import base Durable Object
import { CodeReviewOrchestrator as CodeReviewOrchestratorBase } from './code-review-orchestrator';

// Export Durable Object (with Sentry instrumentation in production)
export const CodeReviewOrchestrator = CodeReviewOrchestratorBase;

// Create Hono app with Env type
type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

// Authentication middleware
app.use(
  '*',
  backendAuthMiddleware<HonoEnv>(c => c.env.BACKEND_AUTH_TOKEN)
);

// Route: POST /review
app.post('/review', async (c: Context<HonoEnv>) => {
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

  console.log('[POST /review] Received review request', {
    reviewId: body.reviewId,
    owner: body.owner,
    agentVersion: body.agentVersion,
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
        agentVersion: body.agentVersion,
        previousCloudAgentSessionId: body.previousCloudAgentSessionId,
      }),
    'start'
  );

  // Fire-and-forget: trigger review execution via HTTP context (no 15-min wall time limit)
  // Routes to cloud-agent SSE or cloud-agent-next based on useCloudAgentNext flag
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

// Route: GET /reviews/:reviewId/events (used by SSE/cloud-agent flow for event polling)
app.get('/reviews/:reviewId/events', async (c: Context<HonoEnv>) => {
  const reviewId = c.req.param('reviewId');
  const attemptId = c.req.query('attemptId') ?? undefined;

  if (!reviewId) {
    return c.json({ error: 'reviewId parameter required' }, 400);
  }

  console.log('[GET /reviews/:reviewId/events] Fetching events', { reviewId });

  // Get Durable Object ID
  const id = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(doNameForAttempt(reviewId, attemptId));

  // Get events via RPC with retry
  const result = await withDORetry(
    () => c.env.CODE_REVIEW_ORCHESTRATOR.get(id),
    stub => stub.getEvents(),
    'getEvents'
  );

  return c.json(result);
});

// Route: GET /reviews/:reviewId/status
app.get('/reviews/:reviewId/status', async (c: Context<HonoEnv>) => {
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
app.post('/reviews/:reviewId/cancel', async (c: Context<HonoEnv>) => {
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
app.post('/reviews/:reviewId/retry-fresh', async (c: Context<HonoEnv>) => {
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

  if (result) {
    const retryId = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(
      doNameForAttempt(reviewId, body.retryAttemptId)
    );
    c.executionCtx.waitUntil(
      withDORetry(
        () => c.env.CODE_REVIEW_ORCHESTRATOR.get(retryId),
        stub => stub.runReview(),
        'runReview'
      ).catch((error: Error) => {
        console.error('[POST /reviews/:reviewId/retry-fresh] runReview failed:', {
          reviewId,
          error: error.message,
        });
      })
    );
  }

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
