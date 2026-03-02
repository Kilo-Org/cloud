import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  deployments,
  deployment_builds,
  deployment_events,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import * as z from 'zod';
import { eq, and, or, ilike, desc, asc, count, isNotNull, gt, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { TRPCError } from '@trpc/server';
import { deleteDeployment } from '@/lib/user-deployments/deployments-service';
import type { AdminDeploymentTableProps, AdminDeploymentBuild } from '@/types/admin-deployments';
import type { Owner } from '@/lib/integrations/core/types';

const ListDeploymentsSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(25),
  sortBy: z.enum(['created_at', 'deployment_slug', 'repository_source']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  ownerType: z.enum(['all', 'user', 'org']).default('all'),
});

const GetBuildsSchema = z.object({
  deploymentId: z.string(),
});

const GetBuildEventsSchema = z.object({
  buildId: z.string(),
  limit: z.number().min(1).max(10000).default(1000),
  afterEventId: z.number().optional(),
});

const DeleteDeploymentSchema = z.object({
  id: z.string(),
});

export const adminDeploymentsRouter = createTRPCRouter({
  list: adminProcedure.input(ListDeploymentsSchema).query(async ({ input }) => {
    const { page, limit, sortBy, sortOrder, search, ownerType } = input;
    const searchTerm = search?.trim() || '';

    // Create alias for created_by user (different from owned_by user)
    const createdByUser = alias(kilocode_users, 'created_by_user');

    // Build where conditions
    const conditions: SQL[] = [];

    // Search condition
    if (searchTerm) {
      const searchConditions: SQL[] = [
        ilike(deployments.deployment_slug, `%${searchTerm}%`),
        ilike(deployments.repository_source, `%${searchTerm}%`),
        ilike(deployments.deployment_url, `%${searchTerm}%`),
        // User IDs are text columns, so always allow exact match search
        eq(deployments.owned_by_user_id, searchTerm),
        eq(deployments.created_by_user_id, searchTerm),
      ];

      // Only add org ID search if searchTerm looks like a valid UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(searchTerm)) {
        searchConditions.push(eq(deployments.owned_by_organization_id, searchTerm));
      }

      const searchCondition = or(...searchConditions);
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    // ownerType filter
    if (ownerType === 'user') {
      conditions.push(isNotNull(deployments.owned_by_user_id));
    } else if (ownerType === 'org') {
      conditions.push(isNotNull(deployments.owned_by_organization_id));
    }
    // 'all' means no filter

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Build order condition
    const orderFunction = sortOrder === 'asc' ? asc : desc;
    const orderCondition = orderFunction(deployments[sortBy]);

    // Query deployments with joins
    const deploymentsResult = await db
      .select({
        deployment: deployments,
        owner_user: {
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
        },
        owner_org: {
          id: organizations.id,
          name: organizations.name,
        },
        created_by: {
          id: createdByUser.id,
          email: createdByUser.google_user_email,
        },
        latestBuild: {
          id: deployment_builds.id,
          status: deployment_builds.status,
        },
      })
      .from(deployments)
      .leftJoin(kilocode_users, eq(deployments.owned_by_user_id, kilocode_users.id))
      .leftJoin(organizations, eq(deployments.owned_by_organization_id, organizations.id))
      .leftJoin(createdByUser, eq(deployments.created_by_user_id, createdByUser.id))
      .leftJoin(deployment_builds, eq(deployments.last_build_id, deployment_builds.id))
      .where(whereCondition)
      .orderBy(orderCondition)
      .limit(limit)
      .offset((page - 1) * limit);

    // Get total count for pagination
    const totalCountResult = await db
      .select({ count: count() })
      .from(deployments)
      .leftJoin(kilocode_users, eq(deployments.owned_by_user_id, kilocode_users.id))
      .leftJoin(organizations, eq(deployments.owned_by_organization_id, organizations.id))
      .where(whereCondition);

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);

    // Transform results to API response format
    const deploymentsData: AdminDeploymentTableProps[] = deploymentsResult.map(row => ({
      id: row.deployment.id,
      deployment_slug: row.deployment.deployment_slug,
      repository_source: row.deployment.repository_source,
      branch: row.deployment.branch,
      deployment_url: row.deployment.deployment_url,
      source_type: row.deployment.source_type,
      created_at: row.deployment.created_at,
      last_deployed_at: row.deployment.last_deployed_at,
      owned_by_user_id: row.deployment.owned_by_user_id,
      owned_by_organization_id: row.deployment.owned_by_organization_id,
      owner_email: row.owner_user?.email || null,
      owner_org_name: row.owner_org?.name || null,
      created_by_user_id: row.deployment.created_by_user_id,
      created_by_user_email: row.created_by?.email || null,
      latest_build_status: row.latestBuild?.status || null,
      latest_build_id: row.latestBuild?.id || null,
    }));

    return {
      deployments: deploymentsData,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages,
      },
    };
  }),

  getBuilds: adminProcedure.input(GetBuildsSchema).query(async ({ input }) => {
    const { deploymentId } = input;

    // Query the last 5 builds for this deployment
    const buildsResult = await db
      .select({
        id: deployment_builds.id,
        status: deployment_builds.status,
        created_at: deployment_builds.created_at,
        started_at: deployment_builds.started_at,
        completed_at: deployment_builds.completed_at,
      })
      .from(deployment_builds)
      .where(eq(deployment_builds.deployment_id, deploymentId))
      .orderBy(desc(deployment_builds.created_at))
      .limit(5);

    // Transform results to API response format
    const builds: AdminDeploymentBuild[] = buildsResult.map(row => ({
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
    }));

    return { builds };
  }),

  getBuildEvents: adminProcedure.input(GetBuildEventsSchema).query(async ({ input }) => {
    const { buildId, limit, afterEventId } = input;

    // Build the query conditions
    const conditions = [eq(deployment_events.build_id, buildId)];

    if (afterEventId !== undefined) {
      conditions.push(gt(deployment_events.event_id, afterEventId));
    }

    // Query deployment events for this build
    const eventsResult = await db
      .select({
        id: deployment_events.event_id,
        ts: deployment_events.timestamp,
        type: deployment_events.event_type,
        payload: deployment_events.payload,
      })
      .from(deployment_events)
      .where(and(...conditions))
      .orderBy(asc(deployment_events.event_id))
      .limit(limit);

    return { events: eventsResult };
  }),

  delete: adminProcedure.input(DeleteDeploymentSchema).mutation(async ({ input }) => {
    const { id: deploymentId } = input;

    // Get owner from deployment
    const deployment = await db.query.deployments.findFirst({
      where: eq(deployments.id, deploymentId),
      columns: {
        owned_by_user_id: true,
        owned_by_organization_id: true,
      },
    });

    if (!deployment) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Deployment not found',
      });
    }

    let owner: Owner;

    if (deployment.owned_by_user_id) {
      owner = { type: 'user', id: deployment.owned_by_user_id };
    } else if (deployment.owned_by_organization_id) {
      owner = { type: 'org', id: deployment.owned_by_organization_id };
    } else {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Deployment has no owner',
      });
    }

    await deleteDeployment(deploymentId, owner);

    return { success: true };
  }),
});
