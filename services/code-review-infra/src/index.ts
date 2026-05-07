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

// Import base Durable Object
import { CodeReviewOrchestrator as CodeReviewOrchestratorBase } from './code-review-orchestrator';

// Export Durable Object (with Sentry instrumentation in production)
export const CodeReviewOrchestrator = CodeReviewOrchestratorBase;

// Create Hono app with Env type
type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

function attemptFromValue(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

function parseAttempt(value: unknown): number | null {
  if (value === undefined) return 1;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isValidAttemptValue(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === 'number') return Number.isInteger(value) && value > 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0;
  }
  return false;
}

function doNameForReview(reviewId: string, attempt: number): string {
  return attempt === 1 ? reviewId : `${reviewId}:${attempt}`;
}

function attemptFromQuery(c: Context<HonoEnv>): Response | number {
  const attempt = parseAttempt(c.req.query('attempt'));
  if (attempt == null) {
    return c.json({ error: 'attempt must be a positive integer' }, 400);
  }
  return attempt;
}

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

  const attempt = attemptFromValue(body.attempt);
  if (!isValidAttemptValue(body.attempt)) {
    return c.json({ error: 'attempt must be a positive integer' }, 400);
  }

  console.log('[POST /review] Received review request', {
    reviewId: body.reviewId,
    attempt,
    owner: body.owner,
    agentVersion: body.agentVersion,
  });

  const doName = doNameForReview(body.reviewId, attempt);

  console.log('[POST /review] Creating DO', {
    reviewId: body.reviewId,
    attempt,
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
        attempt,
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
    attempt,
    owner: body.owner,
    status: result.status,
  });

  // Return 202 Accepted with review details
  const response: CodeReviewResponse = {
    reviewId: body.reviewId,
    attempt,
    status: result.status,
  };

  return c.json(response, 202);
});

// Route: GET /reviews/:reviewId/events (used by SSE/cloud-agent flow for event polling)
app.get('/reviews/:reviewId/events', async (c: Context<HonoEnv>) => {
  const reviewId = c.req.param('reviewId');

  if (!reviewId) {
    return c.json({ error: 'reviewId parameter required' }, 400);
  }

  console.log('[GET /reviews/:reviewId/events] Fetching events', { reviewId });

  const attempt = attemptFromQuery(c);
  if (attempt instanceof Response) return attempt;
  const id = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(doNameForReview(reviewId, attempt));

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

  if (!reviewId) {
    return c.json({ error: 'reviewId parameter required' }, 400);
  }

  console.log('[GET /reviews/:reviewId/status] Fetching status', { reviewId });

  const attempt = attemptFromQuery(c);
  if (attempt instanceof Response) return attempt;
  const id = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(doNameForReview(reviewId, attempt));

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

  let body: { reason?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const reason = body.reason;

  console.log('[POST /reviews/:reviewId/cancel] Cancelling review', { reviewId, reason });

  const attempt = attemptFromQuery(c);
  if (attempt instanceof Response) return attempt;
  const id = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(doNameForReview(reviewId, attempt));

  // Cancel via RPC with retry
  const result = await withDORetry(
    () => c.env.CODE_REVIEW_ORCHESTRATOR.get(id),
    stub => stub.cancel(reason),
    'cancel'
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
