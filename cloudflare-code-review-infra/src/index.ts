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
import { HTTPException } from 'hono/http-exception';
import { bearerAuth } from 'hono/bearer-auth';
import type { Env, CodeReviewRequest, CodeReviewResponse } from './types';
import { withDORetry } from './utils/do-retry';

// Import base Durable Object
import { CodeReviewOrchestrator as CodeReviewOrchestratorBase } from './code-review-orchestrator';

// Export Durable Object (with Sentry instrumentation in production)
export const CodeReviewOrchestrator = CodeReviewOrchestratorBase;

// Create Hono app with Env type
type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

// Authentication middleware
app.use('*', async (c: Context<HonoEnv>, next): Promise<Response> => {
  const authToken = c.env.BACKEND_AUTH_TOKEN;

  // Fail if auth token is not configured
  if (!authToken || authToken.trim() === '') {
    return c.json({ error: 'Unauthorized' }, 401) as Response;
  }

  // Use Hono's bearer auth middleware with error handling
  const authMiddleware = bearerAuth({ token: authToken });
  try {
    return (await authMiddleware(c, next)) as Response;
  } catch (error) {
    // Handle HTTPException from bearer auth
    if (error instanceof HTTPException) {
      return c.json({ error: 'Unauthorized' }, 401) as Response;
    }
    throw error;
  }
});

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
  });

  // Create DO name from reviewId (concurrency controlled by Next.js dispatch)
  const doName = body.reviewId;

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
        authToken: body.authToken,
        sessionInput: body.sessionInput,
        owner: body.owner,
        skipBalanceCheck: body.skipBalanceCheck,
        useCloudAgentNext: body.useCloudAgentNext,
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

  // Get Durable Object ID
  const id = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(reviewId);

  // Get events via RPC with retry
  const result = await withDORetry(
    () => c.env.CODE_REVIEW_ORCHESTRATOR.get(id),
    stub => stub.getEvents(),
    'getEvents'
  );

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

  // Get Durable Object ID
  const id = c.env.CODE_REVIEW_ORCHESTRATOR.idFromName(reviewId);

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
app.onError((err: Error, c: Context<HonoEnv>) => {
  console.error('[Worker] Error:', err);
  return c.json(
    {
      error: 'Internal server error',
      message: err.message || 'Unknown error',
    },
    500
  );
});

// 404 handler
app.notFound((c: Context<HonoEnv>) => {
  return c.json({ error: 'Not found' }, 404);
});

export default app;
