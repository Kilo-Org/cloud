/**
 * Auto Triage Worker - HTTP API
 *
 * HTTP API that receives triage requests and creates Durable Objects
 * to manage the triage lifecycle.
 *
 */

import { Hono, type Context } from 'hono';
import type { Env, TriageRequest, TriageResponse } from './types';
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

// Authentication middleware
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
