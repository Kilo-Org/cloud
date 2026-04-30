/**
 * Auto Triage Worker - HTTP API
 *
 * HTTP API that receives triage requests and creates Durable Objects
 * to manage the triage lifecycle.
 *
 */

import { Hono, type Context } from 'hono';
import type { Env, TriageRequest, TriageResponse } from './types';
import { classificationCallbackPayloadSchema } from './types';
import {
  backendAuthMiddleware,
  createErrorHandler,
  createNotFoundHandler,
} from '@kilocode/worker-utils';

// Import base Durable Object
import { TriageOrchestrator as TriageOrchestratorBase } from './triage-orchestrator';

// Export Durable Object (with Sentry instrumentation in production)
export const TriageOrchestrator = TriageOrchestratorBase;

// Create Hono app with Env type
type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

/**
 * Classification callback from cloud-agent-next.
 *
 * Mounted BEFORE the backend-auth middleware so it can authenticate with a
 * per-ticket secret delivered via `X-Callback-Secret` header instead of the
 * BACKEND_AUTH_TOKEN that Next.js uses. The secret is minted by the DO at
 * prepareSession time and relayed verbatim by cloud-agent-next's callback
 * queue.
 */
app.post('/tickets/:ticketId/classification-callback', async (c: Context<HonoEnv>) => {
  const ticketId = c.req.param('ticketId');
  if (!ticketId) {
    return c.json({ error: 'ticketId parameter required' }, 400);
  }

  const providedSecret = c.req.header('X-Callback-Secret');
  if (!providedSecret) {
    return c.json({ error: 'Missing X-Callback-Secret header' }, 401);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = classificationCallbackPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    console.warn('[POST /tickets/:ticketId/classification-callback] Invalid payload', {
      ticketId,
      issues: parsed.error.issues,
    });
    return c.json({ error: 'Invalid callback payload' }, 400);
  }
  const payload = parsed.data;

  console.log('[POST /tickets/:ticketId/classification-callback] Received', {
    ticketId,
    status: payload.status,
    hasText: typeof payload.lastAssistantMessageText === 'string',
    hasError: !!payload.errorMessage,
  });

  const id = c.env.TRIAGE_ORCHESTRATOR.idFromName(ticketId);
  const stub = c.env.TRIAGE_ORCHESTRATOR.get(id);

  // Return 202 immediately; the DO does its work in the background so we
  // don't block the callback queue on API calls to Next.js. Secret and
  // session-id checks happen inside the DO. Errors are caught and logged;
  // the DO alarm is the last-resort safety net.
  c.executionCtx.waitUntil(
    stub.completeClassification(providedSecret, payload).catch((error: unknown) => {
      console.error(
        '[POST /tickets/:ticketId/classification-callback] completeClassification failed',
        {
          ticketId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    })
  );

  return c.json({ accepted: true }, 202);
});

// Authentication middleware — applied to everything mounted below this line.
app.use(
  '*',
  backendAuthMiddleware<HonoEnv>(c => c.env.BACKEND_AUTH_TOKEN)
);

// Route: POST /triage
app.post('/triage', async (c: Context<HonoEnv>) => {
  let body: TriageRequest;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!body.ticketId || !body.authToken || !body.sessionInput || !body.owner) {
    return c.json(
      {
        error: 'Missing required fields: ticketId, authToken, sessionInput, owner',
      },
      400
    );
  }

  console.log('[POST /triage] Received triage request', {
    ticketId: body.ticketId,
    owner: body.owner,
  });

  // Create DO name from ticketId (concurrency controlled by Next.js dispatch)
  const doName = body.ticketId;

  console.log('[POST /triage] Creating DO', {
    ticketId: body.ticketId,
    doName,
  });

  // Get Durable Object stub
  const id = c.env.TRIAGE_ORCHESTRATOR.idFromName(doName);
  const stub = c.env.TRIAGE_ORCHESTRATOR.get(id);

  // Start the triage via RPC (saves state, returns immediately)
  const result = await stub.start({
    ticketId: body.ticketId,
    authToken: body.authToken,
    sessionInput: body.sessionInput,
    owner: body.owner,
  });

  // Fire-and-forget: trigger triage execution via HTTP context (no 15-min wall time limit)
  // This runs the triage processing without blocking the response
  c.executionCtx.waitUntil(
    stub.runTriage().catch((error: Error) => {
      console.error('[POST /triage] runTriage failed:', {
        ticketId: body.ticketId,
        error: error.message,
      });
    })
  );

  console.log('[POST /triage] Triage started', {
    ticketId: body.ticketId,
    owner: body.owner,
    status: result.status,
  });

  // Return 202 Accepted with triage details
  const response: TriageResponse = {
    ticketId: body.ticketId,
    status: result.status as TriageResponse['status'],
  };

  return c.json(response, 202);
});

// Route: GET /tickets/:ticketId/events
app.get('/tickets/:ticketId/events', async (c: Context<HonoEnv>) => {
  const ticketId = c.req.param('ticketId');

  if (!ticketId) {
    return c.json({ error: 'ticketId parameter required' }, 400);
  }

  console.log('[GET /tickets/:ticketId/events] Fetching events', { ticketId });

  // Get Durable Object stub
  const id = c.env.TRIAGE_ORCHESTRATOR.idFromName(ticketId);
  const stub = c.env.TRIAGE_ORCHESTRATOR.get(id);

  // Get events via RPC
  const result = stub.getEvents();

  return c.json(result);
});

// Health check endpoint
app.get('/health', (c: Context<HonoEnv>) => {
  return c.json({ status: 'ok', service: 'auto-triage-worker' });
});

// Global error handler
app.onError(createErrorHandler());

// 404 handler
app.notFound(createNotFoundHandler());

export default app;
