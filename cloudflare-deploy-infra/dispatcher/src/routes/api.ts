/**
 * Management API routes
 */

import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { validator } from 'hono/validator';
import { z } from 'zod';
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

const validateWorkerParam = validator('param', (value, c) => {
  const result = z.object({ worker: workerNameSchema }).safeParse(value);
  if (!result.success) {
    return c.json({ error: 'Invalid worker name' }, 400);
  }
  return result.data;
});

const validateSlugParam = validator('param', (value, c) => {
  const result = z.object({ slug: slugParamSchema }).safeParse(value);
  if (!result.success) {
    return c.json({ error: 'Invalid slug' }, 400);
  }
  return result.data;
});

const validateSetPasswordBody = validator('json', (value, c) => {
  const result = setPasswordRequestSchema.safeParse(value);
  if (!result.success) {
    return c.json({ error: 'Missing password in body' }, 400);
  }
  return result.data;
});

const validateSetSlugMappingBody = validator('json', (value, c) => {
  const result = setSlugMappingRequestSchema.safeParse(value);
  if (!result.success) {
    return c.json({ error: 'Missing workerName in body' }, 400);
  }
  return result.data;
});

/**
 * Set password protection.
 */
api.put('/password/:worker', validateWorkerParam, validateSetPasswordBody, async c => {
  const { worker } = c.req.valid('param');
  const { password } = c.req.valid('json');

  const record = hashPassword(password);
  await setPasswordRecord(c.env.DEPLOY_KV, worker, record);

  return c.json({
    success: true,
    passwordSetAt: record.createdAt,
  });
});

/**
 * Remove password protection.
 */
api.delete('/password/:worker', validateWorkerParam, async c => {
  const { worker } = c.req.valid('param');

  await deletePasswordRecord(c.env.DEPLOY_KV, worker);

  return c.json({ success: true });
});

/**
 * Check protection status.
 */
api.get('/password/:worker', validateWorkerParam, async c => {
  const { worker } = c.req.valid('param');

  const record = await getPasswordRecord(c.env.DEPLOY_KV, worker);

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

/**
 * Set a slug mapping.
 * Maps a public slug to an internal worker name.
 */
api.put('/slug-mapping/:slug', validateSlugParam, validateSetSlugMappingBody, async c => {
  const { slug } = c.req.valid('param');
  const { workerName } = c.req.valid('json');

  await c.env.DEPLOY_KV.put(`slug:${slug}`, workerName);

  return c.json({ success: true });
});

/**
 * Delete a slug mapping.
 */
api.delete('/slug-mapping/:slug', validateSlugParam, async c => {
  const { slug } = c.req.valid('param');

  await c.env.DEPLOY_KV.delete(`slug:${slug}`);

  return c.json({ success: true });
});

/**
 * Get a slug mapping.
 */
api.get('/slug-mapping/:slug', validateSlugParam, async c => {
  const { slug } = c.req.valid('param');

  const workerName = await c.env.DEPLOY_KV.get(`slug:${slug}`);

  if (workerName) {
    return c.json({ exists: true, workerName });
  }

  return c.json({ exists: false });
});
