import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, ProvisionResponse } from '../types';
import type { CredentialsResponse } from '../api-schemas';
import { requireAdminAuth } from '../utils/auth';
import { getAppDb } from '../utils/db';
import { logger } from '../logger';

const admin = new Hono<{ Bindings: Env }>();

// Apply admin auth to all routes
admin.use('*', async (c: Context<{ Bindings: Env }>, next) => {
  const authError = requireAdminAuth(c);
  if (authError) {
    return authError;
  }
  await next();
});

/**
 * Build the database URL for an app using the request's origin
 */
function buildDbUrl(requestUrl: string, appId: string): string {
  const url = new URL(requestUrl);
  return `${url.origin}/api/${appId}/query`;
}

/**
 * POST /admin/apps/:appId/provision
 * Creates DB DO if not exists, generates runtime token if missing
 */
admin.post('/apps/:appId/provision', async c => {
  const appId = c.req.param('appId');
  logger.setTags({ operation: 'provision' });

  const db = getAppDb(c.env, appId);
  const result = await db.provision();

  logger.info('Database provisioned', { isNew: result.isNew });

  const response: ProvisionResponse = {
    appId,
    dbUrl: buildDbUrl(c.req.url, appId),
    dbToken: result.token,
  };

  return c.json(response, result.isNew ? 201 : 200);
});

/**
 * GET /admin/apps/:appId/credentials
 * Returns credentials info including the token
 */
admin.get('/apps/:appId/credentials', async c => {
  const appId = c.req.param('appId');
  logger.setTags({ operation: 'credentials' });

  const db = getAppDb(c.env, appId);
  const provisioned = await db.isProvisioned();
  const dbToken = await db.getToken();

  const response: CredentialsResponse = {
    appId,
    dbUrl: buildDbUrl(c.req.url, appId),
    dbToken,
    provisioned,
  };

  return c.json(response);
});

/**
 * GET /admin/apps/:appId/schema
 * Returns database schema
 */
admin.get('/apps/:appId/schema', async c => {
  const appId = c.req.param('appId');
  logger.setTags({ operation: 'schema' });

  const db = getAppDb(c.env, appId);
  const schema = await db.getSchema();

  return c.json(schema);
});

/**
 * GET /admin/apps/:appId/export
 * Returns SQLite dump
 */
admin.get('/apps/:appId/export', async c => {
  const appId = c.req.param('appId');
  logger.setTags({ operation: 'export' });
  const accept = c.req.header('Accept') || 'application/json';

  const db = getAppDb(c.env, appId);
  const dump = await db.exportDump();

  // Return as SQL if requested
  if (accept.includes('application/sql') || accept.includes('text/plain')) {
    return c.text(dump, 200, {
      'Content-Type': 'application/sql',
      'Content-Disposition': `attachment; filename="${appId}-export.sql"`,
    });
  }

  // Default to JSON
  return c.json({ dump });
});

export { admin };
