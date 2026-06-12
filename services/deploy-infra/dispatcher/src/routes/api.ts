/**
 * Management API routes
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { validator } from 'hono/validator';
import { z } from 'zod';
import type { Env } from '../types';
import { hashPassword } from '../auth/password';
import { getPasswordRecord, setPasswordRecord, deletePasswordRecord } from '../auth/password-store';
import { isBannerEnabled, enableBanner, disableBanner } from '../banner/banner-store';
import {
  workerNameSchema,
  setPasswordRequestSchema,
  setSlugMappingRequestSchema,
} from '../schemas';

export const api = new Hono<{ Bindings: Env }>();

// Bearer auth middleware for all routes
api.use('*', async (c: Context<{ Bindings: Env }, string>, next) => {
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
    return c.json({ error: 'Missing or invalid slug in body' }, 400);
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

function slugKey(slug: string): string {
  return `slug2worker:${slug}`;
}

function workerKey(worker: string): string {
  return `worker2slug:${worker}`;
}

async function bestEffort(compensate: () => Promise<void>): Promise<void> {
  try {
    await compensate();
  } catch {
    return;
  }
}

/**
 * Set a slug mapping unless the public slug already belongs to another worker.
 */
function registerSlugMappingRoutes(path: string): void {
  api.put(path, validateWorkerParam, validateSetSlugMappingBody, async c => {
    const { worker } = c.req.valid('param');
    const { slug } = c.req.valid('json');
    const forwardKey = slugKey(slug);
    const existingWorker = await c.env.DEPLOY_KV.get(forwardKey);

    if (existingWorker !== null && existingWorker !== worker) {
      return c.json({ error: 'This subdomain is already taken' }, 409);
    }

    const reverseKey = workerKey(worker);
    const previousSlug = await c.env.DEPLOY_KV.get(reverseKey);

    if (previousSlug === null) {
      try {
        await c.env.DEPLOY_KV.put(reverseKey, slug);
        await c.env.DEPLOY_KV.put(forwardKey, worker);
      } catch (mutationError) {
        await bestEffort(async () => {
          if (existingWorker === null && (await c.env.DEPLOY_KV.get(forwardKey)) === worker) {
            await c.env.DEPLOY_KV.delete(forwardKey);
          }
        });
        throw mutationError;
      }

      return c.json({ success: true });
    }

    const previousForwardKey = slugKey(previousSlug);
    let shouldRestorePreviousForward = false;

    try {
      await c.env.DEPLOY_KV.put(forwardKey, worker);

      if (previousSlug !== slug && (await c.env.DEPLOY_KV.get(previousForwardKey)) === worker) {
        shouldRestorePreviousForward = true;
        await c.env.DEPLOY_KV.delete(previousForwardKey);
      }

      await c.env.DEPLOY_KV.put(reverseKey, slug);
    } catch (mutationError) {
      await bestEffort(async () => {
        if (
          existingWorker === null &&
          previousSlug !== slug &&
          (await c.env.DEPLOY_KV.get(forwardKey)) === worker
        ) {
          await c.env.DEPLOY_KV.delete(forwardKey);
        }
      });

      if (shouldRestorePreviousForward) {
        await bestEffort(async () => {
          if ((await c.env.DEPLOY_KV.get(previousForwardKey)) === null) {
            await c.env.DEPLOY_KV.put(previousForwardKey, worker);
          }
        });
      }

      await bestEffort(async () => {
        if ((await c.env.DEPLOY_KV.get(reverseKey)) === slug) {
          await c.env.DEPLOY_KV.put(reverseKey, previousSlug);
        }
      });

      throw mutationError;
    }

    return c.json({ success: true });
  });

  api.delete(path, validateWorkerParam, async c => {
    const { worker } = c.req.valid('param');
    const reverseKey = workerKey(worker);
    const slug = await c.env.DEPLOY_KV.get(reverseKey);

    if (slug !== null) {
      const forwardKey = slugKey(slug);
      if ((await c.env.DEPLOY_KV.get(forwardKey)) === worker) {
        await c.env.DEPLOY_KV.delete(forwardKey);
      }
      if ((await c.env.DEPLOY_KV.get(reverseKey)) === slug) {
        await c.env.DEPLOY_KV.delete(reverseKey);
      }
    } else {
      await c.env.DEPLOY_KV.delete(reverseKey);
    }

    return c.json({ success: true });
  });
}

registerSlugMappingRoutes('/slug-mapping/:worker');
registerSlugMappingRoutes('/quick-deploy-slug-mapping/:worker');

// ============================================================================
// Banner Routes
// Manages the "Made with Kilo App Builder" badge for deployed sites
// ============================================================================

/**
 * Get banner status.
 */
api.get('/app-builder-banner/:worker', validateWorkerParam, async c => {
  const { worker } = c.req.valid('param');
  const enabled = await isBannerEnabled(c.env.DEPLOY_KV, worker);
  return c.json({ enabled });
});

/**
 * Enable banner.
 */
api.put('/app-builder-banner/:worker', validateWorkerParam, async c => {
  const { worker } = c.req.valid('param');
  await enableBanner(c.env.DEPLOY_KV, worker);
  return c.json({ success: true });
});

/**
 * Disable banner.
 */
api.delete('/app-builder-banner/:worker', validateWorkerParam, async c => {
  const { worker } = c.req.valid('param');
  await disableBanner(c.env.DEPLOY_KV, worker);
  return c.json({ success: true });
});
