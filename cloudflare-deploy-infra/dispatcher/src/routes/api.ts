/**
 * Management API routes
 */

import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import type { Env } from '../types';
import { hashPassword } from '../auth/password';
import { getPasswordRecord, setPasswordRecord, deletePasswordRecord } from '../auth/password-store';
import {
  workerNameSchema,
  setPasswordRequestSchema,
  slugParamSchema,
  setSlugMappingRequestSchema,
} from '../schemas';

export const api = new Hono<{ Bindings: Env }>();

// Bearer auth middleware for all routes
api.use('*', async (c, next) => {
  const token = c.env.BACKEND_AUTH_TOKEN;
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return bearerAuth({ token })(c, next);
});

// Worker name validation middleware
api.use('/password/:worker', async (c, next) => {
  const worker = c.req.param('worker');
  const result = workerNameSchema.safeParse(worker);
  if (!result.success) {
    return c.json({ error: 'Invalid worker name' }, 400);
  }
  await next();
});

/**
 * Set password protection.
 */
api.put('/password/:worker', async c => {
  const worker = c.req.param('worker');

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const result = setPasswordRequestSchema.safeParse(rawBody);
  if (!result.success) {
    return c.json({ error: 'Missing password in body' }, 400);
  }

  const record = hashPassword(result.data.password);
  await setPasswordRecord(c.env.DEPLOY_AUTH_KV, worker, record);

  return c.json({
    success: true,
    passwordSetAt: record.createdAt,
  });
});

/**
 * Remove password protection.
 */
api.delete('/password/:worker', async c => {
  const worker = c.req.param('worker');

  await deletePasswordRecord(c.env.DEPLOY_AUTH_KV, worker);

  return c.json({ success: true });
});

/**
 * Check protection status.
 */
api.get('/password/:worker', async c => {
  const worker = c.req.param('worker');

  const record = await getPasswordRecord(c.env.DEPLOY_AUTH_KV, worker);

  if (record) {
    return c.json({
      protected: true,
      passwordSetAt: record.createdAt,
    });
  }

  return c.json({ protected: false });
});

// ============================================================================
// Slug Mapping Routes
// Maps public slugs to internal worker names for custom subdomain support
// ============================================================================

// Slug param validation middleware
api.use('/slug-mapping/:slug', async (c, next) => {
  const slug = c.req.param('slug');
  const result = slugParamSchema.safeParse(slug);
  if (!result.success) {
    return c.json({ error: 'Invalid slug' }, 400);
  }
  await next();
});

/**
 * Set a slug mapping.
 * Maps a public slug to an internal worker name.
 */
api.put('/slug-mapping/:slug', async c => {
  const slug = c.req.param('slug');

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const result = setSlugMappingRequestSchema.safeParse(rawBody);
  if (!result.success) {
    return c.json({ error: 'Missing workerName in body' }, 400);
  }

  await c.env.SLUG_MAPPINGS_KV.put(slug, result.data.workerName);

  return c.json({ success: true });
});

/**
 * Delete a slug mapping.
 */
api.delete('/slug-mapping/:slug', async c => {
  const slug = c.req.param('slug');

  await c.env.SLUG_MAPPINGS_KV.delete(slug);

  return c.json({ success: true });
});

/**
 * Get a slug mapping.
 */
api.get('/slug-mapping/:slug', async c => {
  const slug = c.req.param('slug');

  const workerName = await c.env.SLUG_MAPPINGS_KV.get(slug);

  if (workerName) {
    return c.json({ exists: true, workerName });
  }

  return c.json({ exists: false });
});
