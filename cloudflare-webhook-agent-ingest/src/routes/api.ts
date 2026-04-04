/**
 * API Routes (internal API key auth required)
 *
 * These routes provide CRUD operations for triggers and requests.
 * - Personal triggers: /triggers/user/:userId/:triggerId
 * - Organization triggers: /triggers/org/:orgId/:triggerId
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { HonoContext } from '../index';
import { logger } from '../util/logger';
import { resError, resSuccess } from '@kilocode/worker-utils';
import { withDORetry } from '../util/do-retry';
import { internalApiMiddleware } from '../util/auth';
import { clampRequestLimit } from '../util/constants';
import { decodeUserIdFromPath, encodeUserIdForPath } from '../util/user-id-encoding';
import { validateCronExpression, enforcesMinimumInterval, isValidTimezone } from '../util/cron';

const api = new Hono<HonoContext>();

// Apply internal API key middleware to all API routes
api.use('*', internalApiMiddleware);

// ----------------------------------------------------------------------------
// Personal Trigger Routes (/triggers/user/:userId/:triggerId)
// ----------------------------------------------------------------------------

/**
 * Create/configure a new personal trigger
 */
api.post('/triggers/user/:userId/:triggerId', async c => {
  const { triggerId } = c.req.param();
  const userId = decodeUserIdFromPath(c.req.param('userId'));
  const namespace = `user/${userId}`;
  const doKey = buildDOKey(namespace, triggerId);

  return handleCreateTrigger(c, namespace, triggerId, doKey);
});

/**
 * List captured requests for a personal trigger
 */
api.get('/triggers/user/:userId/:triggerId/requests', async c => {
  const { triggerId } = c.req.param();
  const userId = decodeUserIdFromPath(c.req.param('userId'));
  const namespace = `user/${userId}`;

  return handleListRequests(c, namespace, triggerId);
});

/**
 * Get a single captured request from a personal trigger
 */
api.get('/triggers/user/:userId/:triggerId/requests/:requestId', async c => {
  const { triggerId, requestId } = c.req.param();
  const userId = decodeUserIdFromPath(c.req.param('userId'));
  const namespace = `user/${userId}`;

  return handleGetRequest(c, namespace, triggerId, requestId);
});

/**
 * Get a personal trigger's configuration
 */
api.get('/triggers/user/:userId/:triggerId', async c => {
  const { triggerId } = c.req.param();
  const userId = decodeUserIdFromPath(c.req.param('userId'));
  const namespace = `user/${userId}`;

  return handleGetTrigger(c, namespace, triggerId);
});

/**
 * Update a personal trigger's configuration
 */
api.put('/triggers/user/:userId/:triggerId', async c => {
  const { triggerId } = c.req.param();
  const userId = decodeUserIdFromPath(c.req.param('userId'));
  const namespace = `user/${userId}`;

  return handleUpdateTrigger(c, namespace, triggerId);
});

/**
 * Delete a personal trigger and all its data
 */
api.delete('/triggers/user/:userId/:triggerId', async c => {
  const { triggerId } = c.req.param();
  const userId = decodeUserIdFromPath(c.req.param('userId'));
  const namespace = `user/${userId}`;

  return handleDeleteTrigger(c, namespace, triggerId);
});

// ----------------------------------------------------------------------------
// Organization Trigger Routes (/triggers/org/:orgId/:triggerId)
// ----------------------------------------------------------------------------

/**
 * Create/configure a new organization trigger
 */
api.post('/triggers/org/:orgId/:triggerId', async c => {
  const { orgId, triggerId } = c.req.param();
  const namespace = `org/${orgId}`;
  const doKey = buildDOKey(namespace, triggerId);

  return handleCreateTrigger(c, namespace, triggerId, doKey);
});

/**
 * List captured requests for an organization trigger
 */
api.get('/triggers/org/:orgId/:triggerId/requests', async c => {
  const { orgId, triggerId } = c.req.param();
  const namespace = `org/${orgId}`;

  return handleListRequests(c, namespace, triggerId);
});

/**
 * Get a single captured request from an organization trigger
 */
api.get('/triggers/org/:orgId/:triggerId/requests/:requestId', async c => {
  const { orgId, triggerId, requestId } = c.req.param();
  const namespace = `org/${orgId}`;

  return handleGetRequest(c, namespace, triggerId, requestId);
});

/**
 * Get an organization trigger's configuration
 */
api.get('/triggers/org/:orgId/:triggerId', async c => {
  const { orgId, triggerId } = c.req.param();
  const namespace = `org/${orgId}`;

  return handleGetTrigger(c, namespace, triggerId);
});

/**
 * Update an organization trigger's configuration
 */
api.put('/triggers/org/:orgId/:triggerId', async c => {
  const { orgId, triggerId } = c.req.param();
  const namespace = `org/${orgId}`;

  return handleUpdateTrigger(c, namespace, triggerId);
});

/**
 * Delete an organization trigger and all its data
 */
api.delete('/triggers/org/:orgId/:triggerId', async c => {
  const { orgId, triggerId } = c.req.param();
  const namespace = `org/${orgId}`;

  return handleDeleteTrigger(c, namespace, triggerId);
});

// ============================================================================
// Route Handlers
// ============================================================================

type RouteContext = Context<HonoContext>;

const TriggerConfigInput = z
  .object({
    targetType: z.enum(['cloud_agent', 'kiloclaw_chat']).default('cloud_agent'),
    kiloclawInstanceId: z.string().uuid().optional(),
    githubRepo: z.string().trim().min(1, 'githubRepo is required').optional(),
    mode: z.string().trim().min(1, 'mode is required').optional(),
    model: z.string().trim().min(1, 'model is required').optional(),
    promptTemplate: z.string().trim().min(1, 'promptTemplate is required'),
    profileId: z.string().uuid().optional(),
    autoCommit: z.boolean().optional(),
    condenseOnComplete: z.boolean().optional(),
    webhookAuth: z
      .object({
        header: z.string().trim().min(1, 'webhookAuth.header is required'),
        secret: z.string().trim().min(1, 'webhookAuth.secret is required'),
      })
      .optional(),
    activationMode: z.enum(['webhook', 'scheduled']).default('webhook'),
    cronExpression: z.string().max(100).optional(),
    cronTimezone: z.string().max(50).optional().default('UTC'),
  })
  .superRefine((data, ctx) => {
    if (data.activationMode === 'scheduled') {
      if (!data.cronExpression) {
        ctx.addIssue({
          code: 'custom',
          message: 'cronExpression is required for scheduled triggers',
          path: ['cronExpression'],
        });
      } else {
        const validation = validateCronExpression(data.cronExpression);
        if (!validation.valid) {
          ctx.addIssue({
            code: 'custom',
            message: validation.error ?? 'Invalid cron expression',
            path: ['cronExpression'],
          });
        } else if (!enforcesMinimumInterval(data.cronExpression, data.cronTimezone ?? 'UTC')) {
          ctx.addIssue({
            code: 'custom',
            message: 'Schedule interval must be at least 1 minute',
            path: ['cronExpression'],
          });
        }
      }
      if (data.cronTimezone && !isValidTimezone(data.cronTimezone)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid timezone',
          path: ['cronTimezone'],
        });
      }
      if (data.webhookAuth) {
        ctx.addIssue({
          code: 'custom',
          message: 'webhookAuth is not applicable for scheduled triggers',
          path: ['webhookAuth'],
        });
      }
    }
    if (data.targetType === 'cloud_agent') {
      if (!data.githubRepo)
        ctx.addIssue({
          code: 'custom',
          message: 'githubRepo is required for cloud_agent triggers',
          path: ['githubRepo'],
        });
      if (!data.mode)
        ctx.addIssue({
          code: 'custom',
          message: 'mode is required for cloud_agent triggers',
          path: ['mode'],
        });
      if (!data.model)
        ctx.addIssue({
          code: 'custom',
          message: 'model is required for cloud_agent triggers',
          path: ['model'],
        });
      if (!data.profileId)
        ctx.addIssue({
          code: 'custom',
          message: 'profileId is required for cloud_agent triggers',
          path: ['profileId'],
        });
    }
    if (data.targetType === 'kiloclaw_chat') {
      if (!data.kiloclawInstanceId)
        ctx.addIssue({
          code: 'custom',
          message: 'kiloclawInstanceId is required for kiloclaw_chat triggers',
          path: ['kiloclawInstanceId'],
        });
    }
  });

// Schema for partial updates (PUT endpoint)
// null = explicitly clear the field, undefined = leave unchanged
// Note: targetType and kiloclawInstanceId are intentionally excluded — they are
// immutable after creation. To change target type or instance, delete and recreate.
const TriggerConfigUpdateInput = z
  .object({
    mode: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    promptTemplate: z.string().trim().min(1).optional(),
    isActive: z.boolean().optional(),
    profileId: z.string().uuid().optional(),
    autoCommit: z.boolean().nullable().optional(),
    condenseOnComplete: z.boolean().nullable().optional(),
    webhookAuth: z
      .object({
        header: z.string().trim().min(1).nullable().optional(),
        secret: z.string().trim().min(1).nullable().optional(),
      })
      .optional(),
    // activationMode is immutable — not included here
    cronExpression: z.string().max(100).optional(),
    cronTimezone: z.string().max(50).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.cronExpression !== undefined) {
      const validation = validateCronExpression(data.cronExpression);
      if (!validation.valid) {
        ctx.addIssue({
          code: 'custom',
          message: validation.error ?? 'Invalid cron expression',
          path: ['cronExpression'],
        });
      } else if (!enforcesMinimumInterval(data.cronExpression, data.cronTimezone ?? 'UTC')) {
        ctx.addIssue({
          code: 'custom',
          message: 'Schedule interval must be at least 1 minute',
          path: ['cronExpression'],
        });
      }
    }
    if (data.cronTimezone !== undefined && !isValidTimezone(data.cronTimezone)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid timezone',
        path: ['cronTimezone'],
      });
    }
  });

async function handleCreateTrigger(
  c: RouteContext,
  namespace: string,
  triggerId: string,
  doKey: string
) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request body';
    return c.json(resError(message), 400);
  }

  const parsedConfig = TriggerConfigInput.safeParse(body);
  if (!parsedConfig.success) {
    return c.json(resError(parsedConfig.error.message), 400);
  }

  const config = parsedConfig.data;

  try {
    const result = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.configure(namespace, triggerId, config),
      'configure'
    );

    if (!result.success) {
      return c.json(resError('Failed to configure trigger'), 500);
    }

    // Generate inbound URL (encode userId for OAuth IDs that contain '/')
    const inboundUrl = namespace.startsWith('user/')
      ? `/inbound/user/${encodeUserIdForPath(namespace.slice(5))}/${triggerId}`
      : `/inbound/org/${namespace.slice(4)}/${triggerId}`;

    logger.info('Trigger created', {
      namespace,
      triggerId,
    });

    return c.json(
      resSuccess({
        triggerId,
        namespace,
        message: 'Trigger created successfully',
        inboundUrl,
      }),
      201
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Webhook auth')) {
      logger.warn('Failed to create trigger due to invalid webhook auth', {
        namespace,
        triggerId,
        error: error.message,
      });
      return c.json(resError(error.message), 400);
    }
    logger.error('Failed to create trigger', {
      namespace,
      triggerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(resError('Internal server error'), 500);
  }
}

async function handleGetTrigger(c: RouteContext, namespace: string, triggerId: string) {
  const doKey = buildDOKey(namespace, triggerId);

  try {
    const config = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.getConfigForResponse(),
      'getConfigForResponse'
    );

    if (!config) {
      return c.json(resError('Trigger not found'), 404);
    }

    return c.json(resSuccess(config));
  } catch (error) {
    logger.error('Failed to get trigger', {
      namespace,
      triggerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(resError('Internal server error'), 500);
  }
}

async function handleUpdateTrigger(c: RouteContext, namespace: string, triggerId: string) {
  const doKey = buildDOKey(namespace, triggerId);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request body';
    return c.json(resError(message), 400);
  }

  const parsedUpdates = TriggerConfigUpdateInput.safeParse(body);
  if (!parsedUpdates.success) {
    return c.json(resError(parsedUpdates.error.message), 400);
  }

  const updates = parsedUpdates.data;

  // Check if there are any updates to apply
  if (Object.keys(updates).length === 0) {
    return c.json(resError('No updates provided'), 400);
  }

  try {
    // First check if trigger exists
    const existingConfig = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.getConfig(),
      'getConfig'
    );

    if (!existingConfig) {
      return c.json(resError('Trigger not found'), 404);
    }

    const result = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.updateConfig(updates),
      'updateConfig'
    );

    if (!result.success) {
      return c.json(resError('Failed to update trigger'), 500);
    }

    logger.info('Trigger updated', {
      namespace,
      triggerId,
    });

    // Return updated config (without encryptedSecrets)
    const updatedConfig = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.getConfigForResponse(),
      'getConfigForResponse'
    );

    return c.json(resSuccess(updatedConfig));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Webhook auth')) {
      logger.warn('Failed to update trigger due to invalid webhook auth', {
        namespace,
        triggerId,
        error: error.message,
      });
      return c.json(resError(error.message), 400);
    }
    logger.error('Failed to update trigger', {
      namespace,
      triggerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(resError('Internal server error'), 500);
  }
}

async function handleListRequests(c: RouteContext, namespace: string, triggerId: string) {
  const limit = clampRequestLimit(c.req.query('limit'));
  const doKey = buildDOKey(namespace, triggerId);

  try {
    // First check if trigger exists
    const isActive = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.isActive(),
      'isActive'
    );

    if (!isActive) {
      return c.json(resError('Trigger not found'), 404);
    }

    const result = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.listRequests(limit),
      'listRequests'
    );

    return c.json(resSuccess(result));
  } catch (error) {
    logger.error('Failed to list requests', {
      namespace,
      triggerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(resError('Internal server error'), 500);
  }
}

async function handleGetRequest(
  c: RouteContext,
  namespace: string,
  triggerId: string,
  requestId: string
) {
  const doKey = buildDOKey(namespace, triggerId);

  try {
    // First check if trigger exists
    const isActive = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.isActive(),
      'isActive'
    );

    if (!isActive) {
      return c.json(resError('Trigger not found'), 404);
    }

    const request = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.getRequest(requestId),
      'getRequest'
    );

    if (!request) {
      return c.json(resError('Request not found'), 404);
    }

    return c.json(resSuccess(request));
  } catch (error) {
    logger.error('Failed to get request', {
      namespace,
      triggerId,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(resError('Internal server error'), 500);
  }
}

async function handleDeleteTrigger(c: RouteContext, namespace: string, triggerId: string) {
  const doKey = buildDOKey(namespace, triggerId);

  try {
    // First check if trigger exists
    const isActive = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.isActive(),
      'isActive'
    );

    if (!isActive) {
      return c.json(resError('Trigger not found'), 404);
    }

    const result = await withDORetry(
      () => c.env.TRIGGER_DO.get(c.env.TRIGGER_DO.idFromName(doKey)),
      stub => stub.deleteTrigger(),
      'deleteTrigger'
    );

    if (!result.success) {
      return c.json(resError('Failed to delete trigger'), 500);
    }

    logger.info('Trigger deleted', {
      namespace,
      triggerId,
    });

    return c.json(
      resSuccess({
        message: 'Trigger deleted successfully',
      })
    );
  } catch (error) {
    logger.error('Failed to delete trigger', {
      namespace,
      triggerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(resError('Internal server error'), 500);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build DO key from namespace and triggerId.
 * Format: "namespace/triggerId" (e.g., "user/abc123/my-webhook" or "org/xyz789/my-webhook")
 */
function buildDOKey(namespace: string, triggerId: string): string {
  return `${namespace}/${triggerId}`;
}

export { api };
