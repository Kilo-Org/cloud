import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { getAIAttributionDebugData, deleteAIAttribution } from '@/lib/ai-attribution-service';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { code_indexing_manifest } from '@kilocode/db/schema';
import { eq, and, ilike, desc, sql } from 'drizzle-orm';

const GetDebugDataSchema = z.object({
  organization_id: z.string(),
  project_id: z.string(),
  file_path: z.string(),
  branch: z.string().optional(),
});

const SearchProjectsSchema = z.object({
  organization_id: z.string().uuid(),
  search: z.string().max(100).default(''),
  limit: z.number().min(1).max(50).default(20),
});

const SearchFilePathsSchema = z.object({
  organization_id: z.string().uuid(),
  project_id: z.string(),
  search: z.string().max(200).default(''),
  limit: z.number().min(1).max(50).default(20),
});

const SearchBranchesSchema = z.object({
  organization_id: z.string().uuid(),
  project_id: z.string(),
  search: z.string().max(100).default(''),
  limit: z.number().min(1).max(50).default(20),
});

const DeleteAttributionSchema = z.object({
  organization_id: z.string(),
  project_id: z.string(),
  file_path: z.string(),
  attribution_id: z.number().int().positive(),
});

export const adminAIAttributionRouter = createTRPCRouter({
  getDebugData: adminProcedure.input(GetDebugDataSchema).query(async ({ input }) => {
    return getAIAttributionDebugData(input);
  }),

  searchProjects: adminProcedure.input(SearchProjectsSchema).query(async ({ input }) => {
    const { organization_id, search, limit } = input;

    const whereConditions = [eq(code_indexing_manifest.organization_id, organization_id)];

    if (search) {
      whereConditions.push(ilike(code_indexing_manifest.project_id, `%${search}%`));
    }

    // Get distinct projects with their most recent created_at
    const results = await db
      .select({
        project_id: code_indexing_manifest.project_id,
        max_created_at: sql<string>`MAX(${code_indexing_manifest.created_at})`.as('max_created_at'),
      })
      .from(code_indexing_manifest)
      .where(and(...whereConditions))
      .groupBy(code_indexing_manifest.project_id)
      .orderBy(desc(sql`MAX(${code_indexing_manifest.created_at})`))
      .limit(limit);

    return results.map(r => r.project_id);
  }),

  searchFilePaths: adminProcedure.input(SearchFilePathsSchema).query(async ({ input }) => {
    const { organization_id, project_id, search, limit } = input;

    const whereConditions = [
      eq(code_indexing_manifest.organization_id, organization_id),
      eq(code_indexing_manifest.project_id, project_id),
    ];

    if (search) {
      whereConditions.push(ilike(code_indexing_manifest.file_path, `%${search}%`));
    }

    // Get distinct file paths with their most recent created_at
    const results = await db
      .select({
        file_path: code_indexing_manifest.file_path,
        max_created_at: sql<string>`MAX(${code_indexing_manifest.created_at})`.as('max_created_at'),
      })
      .from(code_indexing_manifest)
      .where(and(...whereConditions))
      .groupBy(code_indexing_manifest.file_path)
      .orderBy(desc(sql`MAX(${code_indexing_manifest.created_at})`))
      .limit(limit);

    return results.map(r => r.file_path);
  }),

  searchBranches: adminProcedure.input(SearchBranchesSchema).query(async ({ input }) => {
    const { organization_id, project_id, search, limit } = input;

    const whereConditions = [
      eq(code_indexing_manifest.organization_id, organization_id),
      eq(code_indexing_manifest.project_id, project_id),
    ];

    if (search) {
      whereConditions.push(ilike(code_indexing_manifest.git_branch, `%${search}%`));
    }

    // Get distinct branches with their most recent created_at
    const results = await db
      .select({
        git_branch: code_indexing_manifest.git_branch,
        max_created_at: sql<string>`MAX(${code_indexing_manifest.created_at})`.as('max_created_at'),
      })
      .from(code_indexing_manifest)
      .where(and(...whereConditions))
      .groupBy(code_indexing_manifest.git_branch)
      .orderBy(desc(sql`MAX(${code_indexing_manifest.created_at})`))
      .limit(limit);

    return results.map(r => r.git_branch);
  }),

  deleteAttribution: adminProcedure.input(DeleteAttributionSchema).mutation(async ({ input }) => {
    return deleteAIAttribution(input);
  }),
});
