import { baseProcedure, createTRPCRouter, type TRPCContext } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { code_indexing_search, code_indexing_manifest } from '@/db/schema';
import { db } from '@/lib/drizzle';
import { eq, getTableName, sql, desc } from 'drizzle-orm';
import {
  ensureOrganizationAccessAndFetchOrg,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';
import { sentryLogger } from '@/lib/utils.server';
import { codeIndexingAdminRouter } from './code-indexing-admin-router';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { getIndexStorage } from '@/lib/code-indexing/storage';
import { getUserUUID } from '@/lib/user.server';
import { findUserByEmail } from '@/lib/user';
import { chunkCountToSizeKbSql } from '@/lib/code-indexing/util';
import { MANAGED_INDEXING_ENABLED } from '@/lib/config.server';
import {
  trackCodeIndexingSearch,
  trackCodeIndexingDelete,
  trackCodeIndexingManifest,
  trackCodeIndexingStats,
  trackCodeIndexingProjectFiles,
  trackCodeIndexingDeleteBeforeDate,
} from '@/lib/code-indexing/posthog-tracking';

// we have a max context lenght of embeddings for 8192 tokens
// if we receive a chunk longer than aproximately this, we just
// truncate it to fit within the limit
// this should only happen when weird minified files get indexed so they're not generally relavant in search results

// const MAX_CHUNK_LENGTH = 8192 * 1.2;

const errorLogger = sentryLogger('code-indexing', 'error');
const storage = getIndexStorage();

const CodebaseIndexingSearchRequestSchema = z.object({
  organizationId: z.uuid().nullable().optional(),
  query: z.string().min(1),
  path: z.string().optional(),
  projectId: z.string(),
  preferBranch: z.string().optional(),
  fallbackBranch: z.string().default('main'),
  excludeFiles: z.array(z.string()).default([]),
});

const CodebaseIndexingStatsSchema = z.object({
  organizationId: z.uuid().nullable().optional(),
  overrideUser: z.string().optional(),
});

const CodebaseIndexingSearchResponseSchema = z.array(
  z.object({
    id: z.string(),
    filePath: z.string(),
    startLine: z.number().min(1),
    endLine: z.number().min(1),
    score: z.number(),
    gitBranch: z.string(),
    fromPreferredBranch: z.boolean(),
  })
);

const CodebaseIndexingDeleteRequestSchema = z.object({
  organizationId: z.uuid().nullable().optional(),
  projectId: z.string(),
  gitBranch: z.string().optional(),
  filePaths: z.array(z.string()).optional(),
});

const CodebaseIndexingDeleteBeforeDateRequestSchema = z.object({
  organizationId: z.uuid().nullable().optional(),
  beforeDate: z.date(),
});

const CodebaseIndexingManifestRequestSchema = z.object({
  organizationId: z.uuid().nullable().optional(),
  projectId: z.string(),
  gitBranch: z.string(),
});

const CodebaseIndexingManifestResponseSchema = z.object({
  organizationId: z.uuid(),
  projectId: z.string(),
  gitBranch: z.string(),
  files: z.record(z.string(), z.string()), // Map of fileHash to filePath
  totalFiles: z.number(),
  lastUpdated: z.string(),
  totalLines: z.number(),
  totalAILines: z.number(),
  percentageOfAILines: z.number(),
});

const CodebaseIndexingProjectFilesRequestSchema = z.object({
  organizationId: z.uuid().nullable().optional(),
  projectId: z.string(),
  gitBranch: z.string().optional(),
  fileSearch: z.string().optional(),
  page: z.number().min(1).default(1),
  pageSize: z.number().min(1).max(50).default(20),
  overrideUser: z.string().optional(),
});

const CodebaseIndexingProjectFilesResponseSchema = z.object({
  files: z.array(
    z.object({
      file_path: z.string(),
      chunk_count: z.number(),
      size_kb: z.number(),
      branches: z.array(z.string()),
      total_lines: z.number(),
      total_ai_lines: z.number(),
      percentage_of_ai_lines: z.number(),
    })
  ),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
  totalLines: z.number(),
  totalAILines: z.number(),
  percentageOfAILines: z.number(),
});

type Input = { organizationId?: string | null | undefined };
export async function getCodeIndexOrganizationId(ctx: TRPCContext, input: Input) {
  if (input.organizationId) {
    const org = await ensureOrganizationAccessAndFetchOrg(ctx, input.organizationId);
    if (org.settings.code_indexing_enabled === false) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Code indexing is not enabled for this organization',
      });
    }
    return input.organizationId;
  }

  return getUserUUID(ctx.user);
}

/**
 * Resolves the organization ID for code indexing operations, with optional admin override.
 * If overrideUser is provided, validates that the requesting user is an admin and resolves
 * the organization ID from either a UUID or email address.
 */
async function resolveOrganizationIdWithOverride(
  ctx: TRPCContext,
  input: { organizationId?: string | null | undefined; overrideUser?: string }
): Promise<string> {
  if (input.overrideUser) {
    if (!ctx.user.is_admin) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only admins can use overrideUser parameter',
      });
    }

    // Check if overrideUser is a UUID (organization ID) or an email
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(input.overrideUser)) {
      // It's an organization ID
      return input.overrideUser;
    } else {
      // It's an email - look up the user
      const user = await findUserByEmail(input.overrideUser);
      if (!user) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `User not found with email: ${input.overrideUser}`,
        });
      }
      // Format the user ID using getUserUUID
      return getUserUUID(user);
    }
  }

  // Normal flow - use the context user/org
  return await getCodeIndexOrganizationId(ctx, input);
}

export const codeIndexingRouter = createTRPCRouter({
  search: baseProcedure
    .input(CodebaseIndexingSearchRequestSchema)
    .output(CodebaseIndexingSearchResponseSchema)
    .query(async ({ ctx, input }) => {
      if (!MANAGED_INDEXING_ENABLED) {
        return [];
      }
      const organizationId = await getCodeIndexOrganizationId(ctx, input);

      // Search using storage class with default provider and collection
      const finalResults = await storage.search({
        query: input.query,
        organizationId: organizationId,
        projectId: input.projectId,
        path: input.path,
        preferBranch: input.preferBranch,
        fallbackBranch: input.fallbackBranch,
        excludeFiles: input.excludeFiles,
      });

      await db.insert(code_indexing_search).values({
        organization_id: organizationId,
        kilo_user_id: ctx.user.id,
        query: input.query,
        project_id: input.projectId,
        metadata: {
          results: finalResults,
          path: input.path,
          preferBranch: input.preferBranch,
          fallbackBranch: input.fallbackBranch,
          excludeFiles: input.excludeFiles,
        },
      });

      // Track search event in PostHog
      trackCodeIndexingSearch({
        distinctId: ctx.user.google_user_email,
        organizationId,
        userId: ctx.user.id,
        projectId: input.projectId,
        query: input.query,
        path: input.path,
        preferBranch: input.preferBranch,
        fallbackBranch: input.fallbackBranch,
        excludeFilesCount: input.excludeFiles.length,
        resultsCount: finalResults.length,
        hasResults: finalResults.length > 0,
      });

      return finalResults;
    }),
  delete: baseProcedure
    .input(CodebaseIndexingDeleteRequestSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const organizationId = await getCodeIndexOrganizationId(ctx, input);

        const deletedFiles = await storage.delete({
          organizationId,
          projectId: input.projectId,
          gitBranch: input.gitBranch,
          filePaths: input.filePaths,
        });

        // Track delete event in PostHog
        trackCodeIndexingDelete({
          distinctId: ctx.user.google_user_email,
          organizationId,
          userId: ctx.user.id,
          projectId: input.projectId,
          gitBranch: input.gitBranch,
          filePathsCount: input.filePaths?.length,
          deletedFiles,
          success: true,
        });

        return { success: true, deletedFiles };
      } catch (e) {
        if (e instanceof Error) {
          errorLogger(e.message);
        } else {
          errorLogger('error deleting files');
        }

        // Track failed delete event
        try {
          const organizationId = await getCodeIndexOrganizationId(ctx, input);
          trackCodeIndexingDelete({
            distinctId: ctx.user.google_user_email,
            organizationId,
            userId: ctx.user.id,
            projectId: input.projectId,
            gitBranch: input.gitBranch,
            filePathsCount: input.filePaths?.length,
            deletedFiles: 0,
            success: false,
          });
        } catch {
          // Ignore tracking errors
        }

        return { success: false, deletedFiles: 0 };
      }
    }),
  getManifest: baseProcedure
    .input(CodebaseIndexingManifestRequestSchema)
    .output(CodebaseIndexingManifestResponseSchema)
    .query(async ({ ctx, input }) => {
      const organizationId = await getCodeIndexOrganizationId(ctx, input);

      // Get manifest using storage class
      const manifest = await storage.getManifest({
        organizationId: organizationId,
        projectId: input.projectId,
        gitBranch: input.gitBranch,
      });

      // Track manifest retrieval in PostHog
      trackCodeIndexingManifest({
        distinctId: ctx.user.google_user_email,
        organizationId,
        userId: ctx.user.id,
        projectId: input.projectId,
        gitBranch: input.gitBranch,
        totalFiles: manifest.totalFiles,
      });

      return manifest;
    }),
  // Fetch recent searches for an organization
  getRecentSearches: organizationMemberProcedure
    .output(
      z.array(
        z.object({
          id: z.uuid(),
          query: z.string(),
          project_id: z.string(),
          created_at: z.string(),
          kilo_user_id: z.string(),
          results_count: z.number(),
          metadata: z.any(),
        })
      )
    )
    .query(async ({ input }) => {
      const organization = await getOrganizationById(input.organizationId);
      if (!organization) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      const searches = await db
        .select({
          id: code_indexing_search.id,
          query: code_indexing_search.query,
          project_id: code_indexing_search.project_id,
          created_at: code_indexing_search.created_at,
          kilo_user_id: code_indexing_search.kilo_user_id,
          metadata: code_indexing_search.metadata,
        })
        .from(code_indexing_search)
        .where(eq(code_indexing_search.organization_id, input.organizationId))
        .orderBy(desc(code_indexing_search.created_at))
        .limit(50);

      return searches.map(search => {
        const metadata = search.metadata as { results?: unknown[] };
        return {
          ...search,
          results_count: metadata?.results?.length || 0,
        };
      });
    }),
  // Non-admin procedures for organization members to view their own org's stats
  getOrganizationStats: baseProcedure
    .input(CodebaseIndexingStatsSchema)
    .output(
      z.array(
        z.object({
          project_id: z.string(),
          chunk_count: z.number(),
          file_count: z.number(),
          percentage_of_org: z.number(),
          size_kb: z.number(),
          last_modified: z.string(),
          branches: z.array(
            z.object({
              branch_name: z.string(),
              last_modified: z.string(),
              file_count: z.number(),
              chunk_count: z.number(),
              size_kb: z.number(),
            })
          ),
        })
      )
    )
    .query(async ({ ctx, input }) => {
      const organizationId = await resolveOrganizationIdWithOverride(ctx, input);

      const manifestTableName = getTableName(code_indexing_manifest);

      const { rows } = await db.execute(sql`
        WITH branch_stats AS (
            SELECT
                project_id,
                git_branch,
                MAX(created_at) as last_modified,
                COUNT(DISTINCT file_path)::int as file_count,
                SUM(chunk_count)::int as branch_chunk_count
            FROM ${sql.identifier(manifestTableName)}
            WHERE organization_id = ${organizationId}
            GROUP BY project_id, git_branch
        ),
        project_file_stats AS (
            SELECT
                project_id,
                COUNT(DISTINCT file_path)::int as total_file_count
            FROM ${sql.identifier(manifestTableName)}
            WHERE organization_id = ${organizationId}
            GROUP BY project_id
        ),
        org_stats AS (
            SELECT
                bs.project_id,
                SUM(bs.branch_chunk_count)::int as chunk_count,
                pfs.total_file_count as file_count,
                JSON_AGG(
                    JSON_BUILD_OBJECT(
                        'branch_name', bs.git_branch,
                        'last_modified', bs.last_modified,
                        'file_count', bs.file_count,
                        'chunk_count', bs.branch_chunk_count,
                        'size_kb', ${chunkCountToSizeKbSql(sql.raw('bs.branch_chunk_count'))}
                    ) ORDER BY bs.last_modified DESC
                ) as branches,
                MAX(bs.last_modified) as last_modified
            FROM branch_stats bs
            JOIN project_file_stats pfs ON bs.project_id = pfs.project_id
            GROUP BY bs.project_id, pfs.total_file_count
        ),
        org_total AS (
            SELECT
                SUM(chunk_count) as total_chunks
            FROM ${sql.identifier(manifestTableName)}
            WHERE organization_id = ${organizationId}
        )
        SELECT
            os.project_id,
            os.chunk_count::int,
            os.file_count::int,
            ROUND((os.chunk_count * 100.0 / NULLIF(ot.total_chunks, 0))::numeric, 2) as percentage_of_org,
            ${chunkCountToSizeKbSql(sql.raw('os.chunk_count'))} as size_kb,
            os.last_modified,
            os.branches
        FROM org_stats os
        CROSS JOIN org_total ot
        ORDER BY os.chunk_count DESC;
      `);

      // Convert BigInt and numeric values, preserving all fields
      const result = rows.map(row => ({
        project_id: String(row.project_id),
        chunk_count: Number(row.chunk_count),
        file_count: Number(row.file_count),
        percentage_of_org: Number(row.percentage_of_org),
        size_kb: Number(row.size_kb),
        last_modified: String(row.last_modified),
        branches: row.branches as Array<{
          branch_name: string;
          last_modified: string;
          file_count: number;
          chunk_count: number;
          size_kb: number;
        }>,
      }));

      // Track stats retrieval in PostHog
      const totalChunks = result.reduce((sum, p) => sum + p.chunk_count, 0);
      const totalFiles = result.reduce((sum, p) => sum + p.file_count, 0);
      const totalSizeKb = result.reduce((sum, p) => sum + p.size_kb, 0);

      trackCodeIndexingStats({
        distinctId: ctx.user.google_user_email,
        organizationId,
        userId: ctx.user.id,
        projectsCount: result.length,
        totalChunks,
        totalFiles,
        totalSizeKb,
        isAdminOverride: !!input.overrideUser,
      });

      return result;
    }),
  getProjectFiles: baseProcedure
    .input(CodebaseIndexingProjectFilesRequestSchema)
    .output(CodebaseIndexingProjectFilesResponseSchema)
    .query(async ({ ctx, input }) => {
      const organizationId = await resolveOrganizationIdWithOverride(ctx, input);

      const manifestTableName = getTableName(code_indexing_manifest);
      const offset = (input.page - 1) * input.pageSize;

      // Build filter conditions
      const branchFilter = input.gitBranch ? sql`AND git_branch = ${input.gitBranch}` : sql``;
      const fileSearchFilter = input.fileSearch
        ? sql`AND file_path ILIKE ${'%' + input.fileSearch + '%'}`
        : sql``;

      // Get total count and AI lines statistics
      // Use a subquery to get unique file stats to avoid double-counting when a file exists in multiple branches
      const countResult = await db.execute(sql`
        SELECT
          COUNT(*)::int as total,
          COALESCE(SUM(total_lines), 0)::int as total_lines,
          COALESCE(SUM(total_ai_lines), 0)::int as total_ai_lines
        FROM (
          SELECT DISTINCT ON (file_path)
            file_path,
            total_lines,
            total_ai_lines
          FROM ${sql.identifier(manifestTableName)}
          WHERE organization_id = ${organizationId}
            AND project_id = ${input.projectId}
            ${branchFilter}
            ${fileSearchFilter}
          ORDER BY file_path, created_at DESC
        ) unique_files
      `);

      const total = Number(countResult.rows[0]?.total || 0);
      const totalPages = Math.ceil(total / input.pageSize);
      const totalLines = Number(countResult.rows[0]?.total_lines || 0);
      const totalAILines = Number(countResult.rows[0]?.total_ai_lines || 0);
      const percentageOfAILines = totalLines > 0 ? (totalAILines / totalLines) * 100 : 0;

      // Get paginated files sorted by size with AI lines data
      // Use MAX for total_lines and total_ai_lines since they should be the same across branches for the same file
      const { rows } = await db.execute(sql`
        SELECT
          file_path,
          SUM(chunk_count)::int as chunk_count,
          ${chunkCountToSizeKbSql(sql.raw('SUM(chunk_count)'))} as size_kb,
          ARRAY_AGG(DISTINCT git_branch ORDER BY git_branch) as branches,
          COALESCE(MAX(total_lines), 0)::int as total_lines,
          COALESCE(MAX(total_ai_lines), 0)::int as total_ai_lines
        FROM ${sql.identifier(manifestTableName)}
        WHERE organization_id = ${organizationId}
          AND project_id = ${input.projectId}
          ${branchFilter}
          ${fileSearchFilter}
        GROUP BY file_path
        ORDER BY SUM(chunk_count) DESC
        LIMIT ${input.pageSize}
        OFFSET ${offset}
      `);

      const files = rows.map(row => {
        const fileTotalLines = Number(row.total_lines || 0);
        const fileTotalAILines = Number(row.total_ai_lines || 0);
        const filePercentageOfAILines =
          fileTotalLines > 0 ? (fileTotalAILines / fileTotalLines) * 100 : 0;
        return {
          file_path: String(row.file_path),
          chunk_count: Number(row.chunk_count),
          size_kb: Number(row.size_kb),
          branches: row.branches as string[],
          total_lines: fileTotalLines,
          total_ai_lines: fileTotalAILines,
          percentage_of_ai_lines: filePercentageOfAILines,
        };
      });

      const response = {
        files,
        total,
        page: input.page,
        pageSize: input.pageSize,
        totalPages,
        totalLines,
        totalAILines,
        percentageOfAILines,
      };

      // Track project files retrieval in PostHog
      trackCodeIndexingProjectFiles({
        distinctId: ctx.user.google_user_email,
        organizationId,
        userId: ctx.user.id,
        projectId: input.projectId,
        page: input.page,
        pageSize: input.pageSize,
        totalFiles: total,
        totalPages,
        isAdminOverride: !!input.overrideUser,
      });

      return response;
    }),
  deleteBeforeDate: baseProcedure
    .input(CodebaseIndexingDeleteBeforeDateRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const organizationId = await getCodeIndexOrganizationId(ctx, input);

      await storage.deleteByOrganizationBeforeDate({
        organizationId,
        beforeDate: input.beforeDate,
      });

      // Track delete before date in PostHog
      trackCodeIndexingDeleteBeforeDate({
        distinctId: ctx.user.google_user_email,
        organizationId,
        userId: ctx.user.id,
        beforeDate: input.beforeDate.toISOString(),
        success: true,
      });

      return { success: true };
    }),
  admin: codeIndexingAdminRouter,
});
