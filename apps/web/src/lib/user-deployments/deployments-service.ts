import 'server-only';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  deployments,
  deployment_builds,
  deployment_events,
  app_builder_projects,
} from '@kilocode/db/schema';
import { eq, and, desc, gt, or } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { apiClient as deployApiClient } from '@/lib/user-deployments/deployment-builder-client';
import * as z from 'zod';
import { eventSchema } from '@/lib/user-deployments/types';
import type { DeploymentSource } from '@/lib/user-deployments/types';
import type { Owner } from '@/lib/integrations/core/types';
import type { PlaintextEnvVar } from '@/lib/user-deployments/env-vars-validation';
import { slugSchema } from './validation';
import { DispatcherSlugTakenError, dispatcherClient } from './dispatcher-client';

/** Thrown when the dispatcher slug mapping update fails during a rename. */
class SlugMappingError extends Error {
  constructor(
    readonly slugTaken: boolean,
    cause: unknown
  ) {
    super('Dispatcher slug mapping failed', { cause });
    this.name = 'SlugMappingError';
  }
}

/** Detect Postgres unique constraint violations (error code 23505) by constraint name.
 * Drizzle wraps Postgres errors, so code/constraint may be on error.cause. */
function isUniqueConstraintError(error: unknown, constraintName: string): boolean {
  if (error === null || typeof error !== 'object') return false;
  const err = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const pgCode = err.code ?? err.cause?.code;
  const pgConstraint = err.constraint ?? err.cause?.constraint;
  return pgCode === '23505' && pgConstraint === constraintName;
}

export type CreateDeploymentResult =
  | { success: true; deploymentId: string; deploymentSlug: string; deploymentUrl: string }
  | { success: false; error: 'payment_required' | 'invalid_slug' | 'slug_taken'; message: string };

import type {
  RenameDeploymentResult,
  CheckSlugAvailabilityResult,
} from '@/lib/user-deployments/router-types';

/**
 * List deployments with their latest builds
 */
export async function listDeployments(owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(deployments.owned_by_user_id, owner.id)
      : eq(deployments.owned_by_organization_id, owner.id);

  const userDeployments = await db
    .select({
      deployment: deployments,
      latestBuild: deployment_builds,
      appBuilderProjectId: app_builder_projects.id,
    })
    .from(deployments)
    .leftJoin(deployment_builds, eq(deployments.last_build_id, deployment_builds.id))
    .leftJoin(app_builder_projects, eq(app_builder_projects.deployment_id, deployments.id))
    .where(ownershipCondition)
    .orderBy(desc(deployments.created_at))
    .limit(100);

  return {
    success: true,
    data: userDeployments.map(row => ({
      deployment: row.deployment,
      latestBuild: row.latestBuild,
      appBuilderProjectId: row.appBuilderProjectId,
    })),
  };
}

/**
 * Get a single deployment with its latest build
 */
export async function getDeployment(deploymentId: string, owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(deployments.owned_by_user_id, owner.id)
      : eq(deployments.owned_by_organization_id, owner.id);

  const result = await db
    .select({
      deployment: deployments,
      latestBuild: deployment_builds,
      appBuilderProjectId: app_builder_projects.id,
    })
    .from(deployments)
    .leftJoin(deployment_builds, eq(deployments.last_build_id, deployment_builds.id))
    .leftJoin(app_builder_projects, eq(app_builder_projects.deployment_id, deployments.id))
    .where(and(eq(deployments.id, deploymentId), ownershipCondition))
    .limit(1);

  if (result.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Deployment not found',
    });
  }

  return {
    success: true,
    deployment: result[0].deployment,
    latestBuild: result[0].latestBuild,
    appBuilderProjectId: result[0].appBuilderProjectId,
  };
}

/**
 * Get events for a build
 */
export async function getBuildEvents(
  deploymentId: string,
  buildId: string,
  owner: Owner,
  limit: number,
  afterEventId?: number
) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(deployments.owned_by_user_id, owner.id)
      : eq(deployments.owned_by_organization_id, owner.id);

  // Verify both deployment and build belong to owner
  const buildVerification = await db
    .select({ buildId: deployment_builds.id })
    .from(deployment_builds)
    .innerJoin(deployments, eq(deployment_builds.deployment_id, deployments.id))
    .where(
      and(eq(deployment_builds.id, buildId), eq(deployments.id, deploymentId), ownershipCondition)
    )
    .limit(1);

  if (buildVerification.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Build not found or does not belong to this deployment',
    });
  }

  const whereClause = afterEventId
    ? and(eq(deployment_events.build_id, buildId), gt(deployment_events.event_id, afterEventId))
    : eq(deployment_events.build_id, buildId);

  const events = await db
    .select({
      id: deployment_events.event_id,
      ts: deployment_events.timestamp,
      type: deployment_events.event_type,
      payload: deployment_events.payload,
    })
    .from(deployment_events)
    .where(whereClause)
    .orderBy(deployment_events.event_id)
    .limit(limit);

  return z.array(eventSchema).parse(events);
}

/**
 * Delete a deployment
 */
export async function deleteDeployment(deploymentId: string, owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(deployments.owned_by_user_id, owner.id)
      : eq(deployments.owned_by_organization_id, owner.id);

  // Verify deployment belongs to owner
  const deployment = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), ownershipCondition))
    .limit(1);

  if (deployment.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Deployment not found',
    });
  }

  // Delete worker deployment from Cloudflare FIRST
  // If this fails, we don't proceed with database/KV cleanup to avoid exposing a still-live deployment
  const workerName = deployment[0].internal_worker_name;
  await deployApiClient.deleteWorker(workerName);

  // Clean up KV records after worker is confirmed deleted (slug mapping, password protection, banner)
  await Promise.allSettled([
    dispatcherClient.deleteSlugMapping(workerName),
    dispatcherClient.removePassword(workerName),
    dispatcherClient.disableBanner(workerName),
  ]);

  // Unlink app builder projects that reference this deployment
  await db
    .update(app_builder_projects)
    .set({ deployment_id: null })
    .where(eq(app_builder_projects.deployment_id, deploymentId));

  // Delete the deployment from the database
  // Related records (builds, events, env_vars) will be cascade deleted
  await db.delete(deployments).where(eq(deployments.id, deploymentId));

  return {
    success: true,
  };
}

/**
 * Cancel a running build
 */
export async function cancelBuild(buildId: string, deploymentId: string, owner: Owner) {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(deployments.owned_by_user_id, owner.id)
      : eq(deployments.owned_by_organization_id, owner.id);

  // Verify build belongs to a deployment owned by the user/org
  const buildVerification = await db
    .select({ buildId: deployment_builds.id, status: deployment_builds.status })
    .from(deployment_builds)
    .innerJoin(deployments, eq(deployment_builds.deployment_id, deployments.id))
    .where(
      and(eq(deployment_builds.id, buildId), eq(deployments.id, deploymentId), ownershipCondition)
    )
    .limit(1);

  if (buildVerification.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Build not found or does not belong to this deployment',
    });
  }

  const currentStatus = buildVerification[0].status;

  if (currentStatus !== 'queued' && currentStatus !== 'building' && currentStatus !== 'deploying') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Cannot cancel build with status: ${currentStatus}.`,
    });
  }

  // Call the builder API to cancel the build
  try {
    const result = await deployApiClient.cancelBuild(buildId);

    // Handle result from builder
    if (!result.cancelled) {
      // not_found or already_finished: Build gone or completed in builder, treat as success
      if (result.reason === 'not_found' || result.reason === 'already_finished') {
        // Update local status if not already in a finished state
        const finishedStatuses = ['deployed', 'failed', 'cancelled'];
        if (!finishedStatuses.includes(currentStatus)) {
          await db
            .update(deployment_builds)
            .set({ status: result.status ?? 'cancelled' })
            .where(eq(deployment_builds.id, buildId));
        }
        return {
          success: true,
        };
      }
    }

    // Successfully cancelled, update build status to cancelled
    await db
      .update(deployment_builds)
      .set({ status: 'cancelled' })
      .where(eq(deployment_builds.id, buildId));

    return {
      success: true,
    };
  } catch (error) {
    if (error instanceof TRPCError) {
      throw error;
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Failed to cancel build: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export async function redeployByDeploymentId(_deploymentId: string, _owner: Owner) {
  throw new TRPCError({
    code: 'METHOD_NOT_SUPPORTED',
    message:
      'Deploy has reached end of life. New deployments and redeployments are no longer available.',
  });
}

const DEFAULT_DEPLOYMENT_DOMAIN = 'd.kiloapps.io';

/**
 * Check if a slug is available for use.
 * Validates format, reserved words, and database uniqueness.
 */
export async function checkSlugAvailability(slug: string): Promise<CheckSlugAvailabilityResult> {
  // Validate format using zod schema (includes reserved word check)
  const parseResult = slugSchema.safeParse(slug);
  if (!parseResult.success) {
    return {
      available: false,
      reason: 'invalid_slug',
      message: parseResult.error.issues[0]?.message ?? 'Invalid slug format',
    };
  }

  // Check database uniqueness — also check internal_worker_name to prevent collisions
  // with renamed deployments whose original worker name differs from their current slug
  const existing = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(or(eq(deployments.deployment_slug, slug), eq(deployments.internal_worker_name, slug)))
    .limit(1);

  if (existing.length > 0) {
    return { available: false, reason: 'slug_taken', message: 'This subdomain is already taken' };
  }

  return { available: true };
}

export async function createDeployment(_params: {
  owner: Owner;
  source: DeploymentSource;
  branch: string;
  createdByUserId: string;
  createdFrom: 'deploy' | 'app-builder';
  envVars?: PlaintextEnvVar[];
}): Promise<CreateDeploymentResult> {
  throw new TRPCError({
    code: 'METHOD_NOT_SUPPORTED',
    message:
      'Deploy has reached end of life. New deployments and redeployments are no longer available.',
  });
}

/**
 * Rename a deployment's slug.
 * Updates the public-facing URL while keeping the internal worker name unchanged.
 */
export async function renameDeployment(
  deploymentId: string,
  newSlug: string,
  owner: Owner
): Promise<RenameDeploymentResult> {
  const ownershipCondition =
    owner.type === 'user'
      ? eq(deployments.owned_by_user_id, owner.id)
      : eq(deployments.owned_by_organization_id, owner.id);

  // Get deployment and verify ownership
  const [deployment] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), ownershipCondition))
    .limit(1);

  if (!deployment) {
    return { success: false, error: 'not_found', message: 'Deployment not found' };
  }

  // No-op if the new slug matches the current slug or internal worker name
  if (newSlug === deployment.deployment_slug || newSlug === deployment.internal_worker_name) {
    return {
      success: true,
      deploymentUrl: deployment.deployment_url,
    };
  }

  const slugCheck = await checkSlugAvailability(newSlug);
  if (!slugCheck.available) {
    return {
      success: false,
      error: slugCheck.reason,
      message: slugCheck.message,
    };
  }

  const oldSlug = deployment.deployment_slug;
  const internalWorkerName = deployment.internal_worker_name;
  const newUrl = `https://${newSlug}.${DEFAULT_DEPLOYMENT_DOMAIN}`;

  let slugMappingUpdated = false;

  try {
    const slugWasConcurrentlyTaken = await db.transaction(async tx => {
      // The database guards stored deployment conflicts; the dispatcher also reserves quick URLs.
      // Optimistic locking: only update if the slug hasn't changed since we read it.
      const [row] = await tx
        .update(deployments)
        .set({
          deployment_slug: newSlug,
          deployment_url: newUrl,
        })
        .where(and(eq(deployments.id, deploymentId), eq(deployments.deployment_slug, oldSlug)))
        .returning({ id: deployments.id });

      if (!row) {
        return true;
      }

      // The dispatcher reserves the new public slug and removes the prior mapping.
      // If the database transaction later aborts, the catch path restores the old mapping.
      try {
        await dispatcherClient.setSlugMapping(internalWorkerName, newSlug);
        slugMappingUpdated = true;
      } catch (cause) {
        throw new SlugMappingError(cause instanceof DispatcherSlugTakenError, cause);
      }

      return false;
    });

    if (slugWasConcurrentlyTaken) {
      return {
        success: false,
        error: 'slug_taken',
        message: 'This subdomain was taken',
      };
    }
  } catch (err) {
    if (slugMappingUpdated) {
      try {
        await dispatcherClient.setSlugMapping(internalWorkerName, oldSlug);
      } catch {
        return {
          success: false,
          error: 'internal_error',
          message: 'Failed to restore subdomain routing. Please try again.',
        };
      }
    }

    if (err instanceof SlugMappingError) {
      return err.slugTaken
        ? {
            success: false,
            error: 'slug_taken',
            message: 'This subdomain is already taken',
          }
        : {
            success: false,
            error: 'internal_error',
            message: 'Failed to update subdomain routing. Please try again.',
          };
    }
    if (isUniqueConstraintError(err, 'UQ_deployments_deployment_slug')) {
      return {
        success: false,
        error: 'slug_taken',
        message: 'This subdomain is already taken',
      };
    }
    throw err;
  }

  return { success: true, deploymentUrl: newUrl };
}
