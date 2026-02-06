import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { app_builder_projects, kilocode_users, organizations, cliSessions } from '@/db/schema';
import * as z from 'zod';
import { eq, and, or, ilike, desc, asc, count, isNotNull, type SQL } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as appBuilderClient from '@/lib/app-builder/app-builder-client';

const ListProjectsSchema = z.object({
  offset: z.number().min(0).default(0),
  limit: z.number().min(1).max(100).default(25),
  sortBy: z.enum(['created_at', 'last_message_at', 'title']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  ownerType: z.enum(['all', 'user', 'org']).default('all'),
});

const DeleteProjectSchema = z.object({
  id: z.string().uuid(),
});

const GetProjectSchema = z.object({
  id: z.string().uuid(),
});

export type AdminAppBuilderProject = {
  id: string;
  title: string;
  model_id: string;
  template: string | null;
  session_id: string | null;
  deployment_id: string | null;
  created_by_user_id: string | null;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  owner_email: string | null;
  owner_org_name: string | null;
  is_deployed: boolean;
};

export type AdminAppBuilderProjectDetail = AdminAppBuilderProject & {
  cli_session_id: string | null;
};

export const adminAppBuilderRouter = createTRPCRouter({
  get: adminProcedure.input(GetProjectSchema).query(async ({ input }) => {
    const { id: projectId } = input;

    // Query project with joins for owner info
    const [result] = await db
      .select({
        project: app_builder_projects,
        owner_user: {
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
        },
        owner_org: {
          id: organizations.id,
          name: organizations.name,
        },
      })
      .from(app_builder_projects)
      .leftJoin(kilocode_users, eq(app_builder_projects.owned_by_user_id, kilocode_users.id))
      .leftJoin(organizations, eq(app_builder_projects.owned_by_organization_id, organizations.id))
      .where(eq(app_builder_projects.id, projectId))
      .limit(1);

    if (!result) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Project not found',
      });
    }

    // Look up the CLI session by cloud_agent_session_id
    let cliSessionId: string | null = null;
    if (result.project.session_id) {
      const [cliSession] = await db
        .select({ session_id: cliSessions.session_id })
        .from(cliSessions)
        .where(eq(cliSessions.cloud_agent_session_id, result.project.session_id))
        .limit(1);
      cliSessionId = cliSession?.session_id ?? null;
    }

    const projectDetail: AdminAppBuilderProjectDetail = {
      id: result.project.id,
      title: result.project.title,
      model_id: result.project.model_id,
      template: result.project.template,
      session_id: result.project.session_id,
      deployment_id: result.project.deployment_id,
      created_by_user_id: result.project.created_by_user_id,
      owned_by_user_id: result.project.owned_by_user_id,
      owned_by_organization_id: result.project.owned_by_organization_id,
      created_at: result.project.created_at,
      updated_at: result.project.updated_at,
      last_message_at: result.project.last_message_at,
      owner_email: result.owner_user?.email ?? null,
      owner_org_name: result.owner_org?.name ?? null,
      is_deployed: result.project.deployment_id !== null,
      cli_session_id: cliSessionId,
    };

    return projectDetail;
  }),

  list: adminProcedure.input(ListProjectsSchema).query(async ({ input }) => {
    const { offset, limit, sortBy, sortOrder, search, ownerType } = input;
    const searchTerm = search?.trim() || '';

    // Build where conditions
    const conditions: SQL[] = [];

    // Search condition
    if (searchTerm) {
      const searchConditions: SQL[] = [
        ilike(app_builder_projects.title, `%${searchTerm}%`),
        // User IDs are text columns, so always allow exact match search
        eq(app_builder_projects.owned_by_user_id, searchTerm),
        eq(app_builder_projects.created_by_user_id, searchTerm),
      ];

      // Only add org ID search if searchTerm looks like a valid UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(searchTerm)) {
        searchConditions.push(eq(app_builder_projects.owned_by_organization_id, searchTerm));
      }

      const searchCondition = or(...searchConditions);
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    // ownerType filter
    if (ownerType === 'user') {
      conditions.push(isNotNull(app_builder_projects.owned_by_user_id));
    } else if (ownerType === 'org') {
      conditions.push(isNotNull(app_builder_projects.owned_by_organization_id));
    }
    // 'all' means no filter

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Build order condition
    const orderFunction = sortOrder === 'asc' ? asc : desc;
    const orderCondition = orderFunction(app_builder_projects[sortBy]);

    // Query projects with joins
    const projectsResult = await db
      .select({
        project: app_builder_projects,
        owner_user: {
          id: kilocode_users.id,
          email: kilocode_users.google_user_email,
        },
        owner_org: {
          id: organizations.id,
          name: organizations.name,
        },
      })
      .from(app_builder_projects)
      .leftJoin(kilocode_users, eq(app_builder_projects.owned_by_user_id, kilocode_users.id))
      .leftJoin(organizations, eq(app_builder_projects.owned_by_organization_id, organizations.id))
      .where(whereCondition)
      .orderBy(orderCondition)
      .limit(limit)
      .offset(offset);

    // Get total count for pagination
    const totalCountResult = await db
      .select({ count: count() })
      .from(app_builder_projects)
      .leftJoin(kilocode_users, eq(app_builder_projects.owned_by_user_id, kilocode_users.id))
      .leftJoin(organizations, eq(app_builder_projects.owned_by_organization_id, organizations.id))
      .where(whereCondition);

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);

    // Transform results to API response format
    const projectsData: AdminAppBuilderProject[] = projectsResult.map(row => ({
      id: row.project.id,
      title: row.project.title,
      model_id: row.project.model_id,
      template: row.project.template,
      session_id: row.project.session_id,
      deployment_id: row.project.deployment_id,
      created_by_user_id: row.project.created_by_user_id,
      owned_by_user_id: row.project.owned_by_user_id,
      owned_by_organization_id: row.project.owned_by_organization_id,
      created_at: row.project.created_at,
      updated_at: row.project.updated_at,
      last_message_at: row.project.last_message_at,
      owner_email: row.owner_user?.email || null,
      owner_org_name: row.owner_org?.name || null,
      is_deployed: row.project.deployment_id !== null,
    }));

    return {
      projects: projectsData,
      pagination: {
        offset,
        limit,
        total: totalCount,
        totalPages,
      },
    };
  }),

  delete: adminProcedure.input(DeleteProjectSchema).mutation(async ({ input }) => {
    const { id: projectId } = input;

    // Verify project exists
    const project = await db.query.app_builder_projects.findFirst({
      where: eq(app_builder_projects.id, projectId),
      columns: {
        id: true,
      },
    });

    if (!project) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Project not found',
      });
    }

    // Delete external resources (git repo, etc.)
    await appBuilderClient.deleteProject(projectId);

    // Delete the project (messages cascade via FK)
    await db.delete(app_builder_projects).where(eq(app_builder_projects.id, projectId));

    return { success: true };
  }),
});
