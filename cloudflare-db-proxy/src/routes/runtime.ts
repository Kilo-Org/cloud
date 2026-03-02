import { Hono } from 'hono';
import type { Env, QuerySuccessResponse, BatchSuccessResponse } from '../types';
import { extractBearerToken, errorResponse } from '../utils/auth';
import { parseQueryRequest, parseBatchRequest } from '../utils/validation';
import { getAppDb } from '../utils/db';
import { logger, formatError } from '../logger';

const runtime = new Hono<{ Bindings: Env }>();

/**
 * POST /api/:appId/query
 * Execute a single SQL query
 */
runtime.post('/:appId/query', async c => {
  const appId = c.req.param('appId');
  const token = extractBearerToken(c);

  if (!token) {
    return errorResponse(c, 'UNAUTHORIZED', 'Missing authorization token', 401);
  }

  // Get the DO
  const db = getAppDb(c.env, appId);

  // Verify token
  const isValid = await db.verifyToken(token);
  if (!isValid) {
    return errorResponse(c, 'UNAUTHORIZED', 'Invalid authorization token', 401);
  }

  // Parse request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, 'INVALID_REQUEST', 'Invalid JSON body', 400);
  }

  const parsed = parseQueryRequest(body);
  if (!parsed.success) {
    return errorResponse(c, 'INVALID_REQUEST', parsed.error, 400);
  }

  // Execute query
  logger.setTags({ operation: 'query' });
  try {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC stub wraps return in Rpc.Promisified
    const result = (await db.executeQuery(
      parsed.data.sql,
      parsed.data.params,
      parsed.data.method
    )) as QuerySuccessResponse;
    return c.json(result);
  } catch (error) {
    logger.error('Query execution failed', formatError(error));
    const message = error instanceof Error ? error.message : 'Query execution failed';
    return errorResponse(c, 'SQL_ERROR', message, 400);
  }
});

/**
 * POST /api/:appId/batch
 * Execute multiple SQL queries in a transaction
 */
runtime.post('/:appId/batch', async c => {
  const appId = c.req.param('appId');
  const token = extractBearerToken(c);

  if (!token) {
    return errorResponse(c, 'UNAUTHORIZED', 'Missing authorization token', 401);
  }

  // Get the DO
  const db = getAppDb(c.env, appId);

  // Verify token
  const isValid = await db.verifyToken(token);
  if (!isValid) {
    return errorResponse(c, 'UNAUTHORIZED', 'Invalid authorization token', 401);
  }

  // Parse request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return errorResponse(c, 'INVALID_REQUEST', 'Invalid JSON body', 400);
  }

  const parsed = parseBatchRequest(body);
  if (!parsed.success) {
    return errorResponse(c, 'INVALID_REQUEST', parsed.error, 400);
  }

  // Execute batch
  logger.setTags({ operation: 'batch' });
  try {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC stub wraps return in Rpc.Promisified
    const results = (await db.executeBatch(parsed.data.queries)) as BatchSuccessResponse;
    return c.json(results);
  } catch (error) {
    logger.error('Batch execution failed', formatError(error));
    const message = error instanceof Error ? error.message : 'Batch execution failed';
    return errorResponse(c, 'SQL_ERROR', message, 400);
  }
});

export { runtime };
