/**
 * Cloudflare Worker entry point for AI Attributions Tracking
 */

import { Hono } from 'hono';
import { useWorkersLogger } from 'workers-tagged-logger';
import { AttributionTrackerDO, getAttributionTrackerDO } from './dos/AttributionTracker.do';
import { logger } from './util/logger';
import { resError, resSuccess } from '@kilocode/worker-utils';
import { authMiddleware } from './util/auth';
import { adminAuthMiddleware } from './util/admin-auth';
import {
  AdminAttributionsQueryParams,
  AdminDeleteAttributionParams,
  AttributionsTrackRequestBody,
  AttributionEventResponse,
} from './schemas';

export { AttributionTrackerDO };

export type HonoContext = {
  Bindings: Env;
  Variables: {
    user_id: string;
    token: string;
    organization_id: string;
    organization_role: string;
  };
};

const app = new Hono<HonoContext>();

app.use('*', useWorkersLogger('ai-attribution'));

// Health check endpoint (no auth required)
app.get('/health', c => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Apply auth middleware to all /attributions/* routes
app.use('/attributions/*', authMiddleware);

// GET /attributions/whoami - Test authentication and return user info
app.get('/attributions/whoami', c => {
  return c.json(
    resSuccess({
      user_id: c.get('user_id'),
      organization_id: c.get('organization_id'),
      organization_role: c.get('organization_role'),
    })
  );
});

// POST /attributions/track - Track a new attribution
app.post('/attributions/track', async c => {
  const env = c.env;
  const user_id = c.get('user_id');
  const organization_id = c.get('organization_id');

  // Parse and validate request body
  let payload: AttributionsTrackRequestBody;
  try {
    const body: unknown = await c.req.json();
    payload = AttributionsTrackRequestBody.parse(body);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return c.json(resError('Invalid request payload:\n' + errMsg), 400);
  }

  // Get DurableObject stub
  const stub = getAttributionTrackerDO(env, {
    organization_id,
    project_id: payload.project_id,
    file_path: payload.file_path,
  });

  // Track attribution
  try {
    const result = await stub.trackAttribution({
      ...payload,
      user_id,
      organization_id,
    });

    return c.json(resSuccess(result));
  } catch (error) {
    console.error(error);
    logger.error('Failed to track attribution', {
      error: error instanceof Error ? error.message : String(error),
      organization_id,
      project_id: payload.project_id,
      branch: payload.branch,
      file_path: payload.file_path,
    });
    return c.json(resError('Failed to track attribution'), 500);
  }
});

// ============================================================================
// Admin Routes (service-to-service communication)
// ============================================================================

// Apply admin auth middleware to all /admin/* routes
app.use('/admin/*', adminAuthMiddleware);

// GET /admin/health - Admin health check (verifies admin auth is working)
app.get('/admin/health', c => {
  return c.json(
    resSuccess({
      status: 'ok',
      timestamp: new Date().toISOString(),
    })
  );
});

// GET /admin/attributions - Get lines added for a given organization/project/file_path
// Optionally filter by branch. Returns an object where keys are line hashes and values are arrays of line numbers
app.get('/admin/attributions', async c => {
  const env = c.env;

  // Parse and validate query params
  let params: AdminAttributionsQueryParams;
  try {
    const query = c.req.query();
    params = AdminAttributionsQueryParams.parse({
      organization_id: query.organization_id,
      project_id: query.project_id,
      file_path: query.file_path,
      branch: query.branch || undefined,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return c.json(resError('Invalid query parameters:\n' + errMsg), 400);
  }

  // Get DurableObject stub
  const stub = getAttributionTrackerDO(env, {
    organization_id: params.organization_id,
    project_id: params.project_id,
    file_path: params.file_path,
  });

  // Get lines added grouped by hash, optionally filtered by branch
  try {
    const linesAddedByHash = await stub.getLinesAddedByHash(params.branch);
    return c.json(resSuccess({ lines_added: linesAddedByHash }));
  } catch (error) {
    console.error(error);
    logger.error('Failed to get attributions', {
      error: error instanceof Error ? error.message : String(error),
      ...params,
    });
    return c.json(resError('Failed to get attributions'), 500);
  }
});

// GET /admin/attribution-events - Get attribution events with ordered line hashes for flexible retention
// This endpoint returns data structured for the LCS-based retention calculation
app.get('/admin/attribution-events', async c => {
  const env = c.env;

  // Parse and validate query params
  let params: AdminAttributionsQueryParams;
  try {
    const query = c.req.query();
    params = AdminAttributionsQueryParams.parse({
      organization_id: query.organization_id,
      project_id: query.project_id,
      file_path: query.file_path,
      branch: query.branch || undefined,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return c.json(resError('Invalid query parameters:\n' + errMsg), 400);
  }

  // Get DurableObject stub
  const stub = getAttributionTrackerDO(env, {
    organization_id: params.organization_id,
    project_id: params.project_id,
    file_path: params.file_path,
  });

  // Get attribution events with ordered line hashes
  try {
    const events = await stub.getAttributionEvents(params.branch);
    // Validate response shape
    const validatedEvents = events.map(e => AttributionEventResponse.parse(e));
    return c.json(resSuccess({ events: validatedEvents }));
  } catch (error) {
    console.error(error);
    logger.error('Failed to get attribution events', {
      error: error instanceof Error ? error.message : String(error),
      ...params,
    });
    return c.json(resError('Failed to get attribution events'), 500);
  }
});

// GET /admin/debug-data - Get all debug data for a Durable Object
// This endpoint returns the same data as the /debug/do route but as JSON for the admin panel
app.get('/admin/debug-data', async c => {
  const env = c.env;

  // Parse and validate query params
  let params: AdminAttributionsQueryParams;
  try {
    const query = c.req.query();
    params = AdminAttributionsQueryParams.parse({
      organization_id: query.organization_id,
      project_id: query.project_id,
      file_path: query.file_path,
      branch: query.branch || undefined,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return c.json(resError('Invalid query parameters:\n' + errMsg), 400);
  }

  // Get DurableObject stub
  const stub = getAttributionTrackerDO(env, {
    organization_id: params.organization_id,
    project_id: params.project_id,
    file_path: params.file_path,
  });

  // Get debug data from the DO
  try {
    const debugData = await stub.getDebugData();
    const doKey = `${params.organization_id}/${params.project_id}/${params.file_path}`;
    return c.json(resSuccess({ doKey, ...debugData }));
  } catch (error) {
    console.error(error);
    logger.error('Failed to get debug data', {
      error: error instanceof Error ? error.message : String(error),
      ...params,
    });
    return c.json(resError('Failed to get debug data'), 500);
  }
});

// DELETE /admin/attribution/:id - Delete a single attribution and its associated lines
app.delete('/admin/attribution/:id', async c => {
  const env = c.env;

  // Parse and validate params
  let params: AdminDeleteAttributionParams;
  try {
    const query = c.req.query();
    const id = c.req.param('id');
    params = AdminDeleteAttributionParams.parse({
      organization_id: query.organization_id,
      project_id: query.project_id,
      file_path: query.file_path,
      attribution_id: id,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return c.json(resError('Invalid parameters:\n' + errMsg), 400);
  }

  // Get DurableObject stub
  const stub = getAttributionTrackerDO(env, {
    organization_id: params.organization_id,
    project_id: params.project_id,
    file_path: params.file_path,
  });

  // Delete the attribution
  try {
    const deleted = await stub.deleteAttribution(params.attribution_id);
    if (!deleted) {
      return c.json(resError('Attribution not found'), 404);
    }
    return c.json(resSuccess({ deleted: true, attribution_id: params.attribution_id }));
  } catch (error) {
    console.error(error);
    logger.error('Failed to delete attribution', {
      error: error instanceof Error ? error.message : String(error),
      ...params,
    });
    return c.json(resError('Failed to delete attribution'), 500);
  }
});

// 404 handler
app.notFound(c => {
  return c.json({ success: false, error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
  });
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

export default app;
