import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { code_indexing_manifest, organizations, kilocode_users } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { getTableName, sql } from 'drizzle-orm';
import * as z from 'zod';
import { QDRANT_HOST, QDRANT_API_KEY, QDRANT_CLUSTER_RAM_GB } from '@/lib/config.server';
import { chunkCountToSizeKbSql } from '@/lib/code-indexing/util';

const PaginationInputSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  sortBy: z
    .enum([
      'organization_name',
      'chunk_count',
      'project_count',
      'branch_count',
      'percentage_of_rows',
      'size_kb',
      'last_modified',
    ])
    .default('size_kb'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const UserPaginationInputSchema = z.object({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
  sortBy: z
    .enum([
      'user_email',
      'chunk_count',
      'project_count',
      'branch_count',
      'percentage_of_rows',
      'size_kb',
      'last_modified',
    ])
    .default('size_kb'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const IndexOperationalInfoSchema = z.object({
  items: z.array(
    z.object({
      organization_id: z.string(),
      organization_name: z.string(),
      chunk_count: z.number(),
      project_count: z.number(),
      branch_count: z.number(),
      percentage_of_rows: z.number(),
      size_kb: z.number(),
      last_modified: z.string(),
    })
  ),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
});

const UserIndexOperationalInfoSchema = z.object({
  items: z.array(
    z.object({
      kilo_user_id: z.string(),
      user_email: z.string(),
      chunk_count: z.number(),
      project_count: z.number(),
      branch_count: z.number(),
      percentage_of_rows: z.number(),
      size_kb: z.number(),
      last_modified: z.string(),
    })
  ),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
});

const ClusterStatusSchema = z.object({
  // PostgreSQL stats
  totalPostgresRows: z.number(),

  // System info
  distribution: z.string(),
  distributionVersion: z.string(),
  isDocker: z.boolean(),
  cpuCores: z.number(),
  totalRamBytes: z.number(),
  totalDiskBytes: z.number(),
  cpuFlags: z.string(),

  // Memory stats
  memoryActiveBytes: z.number(),
  memoryAllocatedBytes: z.number(),
  memoryMetadataBytes: z.number(),
  memoryResidentBytes: z.number(),
  memoryRetainedBytes: z.number(),

  // Main collection stats (org-code-indexing)
  mainCollectionPoints: z.number(),
  mainCollectionOptimizersStatus: z.string(),

  // Cluster health
  clusterRole: z.string(),
  clusterPeers: z.number(),
  clusterPendingOperations: z.number(),
  consensusStatus: z.string(),

  // App info
  qdrantVersion: z.string(),
  uptime: z.string(),
});

export const codeIndexingAdminRouter = createTRPCRouter({
  getSummaryStats: adminProcedure
    .input(PaginationInputSchema)
    .output(IndexOperationalInfoSchema)
    .query(async ({ input }) => {
      const { page, pageSize, sortBy, sortOrder } = input;
      const offset = (page - 1) * pageSize;

      // Map frontend field names to SQL column names
      const sortColumnMap: Record<string, string> = {
        organization_name: 'organization_name',
        chunk_count: 'chunk_count',
        project_count: 'project_count',
        branch_count: 'branch_count',
        percentage_of_rows: 'percentage_of_rows',
        size_kb: 'size_kb',
        last_modified: 'last_modified',
      };
      const sortColumn = sortColumnMap[sortBy] || 'size_kb';
      // Implementation for getting operational info for organization indexes only
      const manifestTableName = getTableName(code_indexing_manifest);
      const orgTableName = getTableName(organizations);
      const orgIdColumn = code_indexing_manifest.organization_id.name;
      const orgNameColumn = organizations.name.name;
      const userIdColumn = code_indexing_manifest.kilo_user_id.name;

      // Get total count
      const { rows: countRows } = await db.execute(sql`
      SELECT COUNT(DISTINCT ${sql.identifier(orgIdColumn)})::int as total
      FROM ${sql.identifier(manifestTableName)}
      WHERE ${sql.identifier(userIdColumn)} IS NULL
    `);
      const total = Number(countRows[0]?.total || 0);

      // Get paginated data
      const { rows } = await db.execute(sql`
      WITH table_stats AS (
          SELECT
              ${sql.identifier(orgIdColumn)},
              SUM(chunk_count) as chunk_count,
              SUM(chunk_count) * 100.0 / SUM(SUM(chunk_count)) OVER () as percentage,
              COUNT(DISTINCT project_id) as project_count,
              COUNT(DISTINCT git_branch) as branch_count,
              MAX(created_at) as last_modified
          FROM ${sql.identifier(manifestTableName)}
          WHERE ${sql.identifier(userIdColumn)} IS NULL
          GROUP BY ${sql.identifier(orgIdColumn)}
      ),
      total_chunks AS (
          SELECT
              SUM(chunk_count) as total_chunks
          FROM ${sql.identifier(manifestTableName)}
          WHERE ${sql.identifier(userIdColumn)} IS NULL
      )
      SELECT
          ts.${sql.identifier(orgIdColumn)},
          o.${sql.identifier(orgNameColumn)} as organization_name,
          ts.chunk_count::int,
          ts.project_count::int,
          ts.branch_count::int,
          ROUND(ts.percentage, 2) as percentage_of_rows,
          ${chunkCountToSizeKbSql(sql.raw('ts.chunk_count'))} as size_kb,
          ts.last_modified
      FROM table_stats ts
      CROSS JOIN total_chunks
      LEFT JOIN ${sql.identifier(orgTableName)} o ON ts.${sql.identifier(orgIdColumn)} = o.id
      ORDER BY ${sql.identifier(sortColumn)} ${sql.raw(sortOrder.toUpperCase())}
      LIMIT ${pageSize}
      OFFSET ${offset};
      `);

      // Convert BigInt and numeric string values to numbers for JSON serialization
      const items = rows.map(row => ({
        ...row,
        chunk_count: Number(row.chunk_count),
        project_count: Number(row.project_count),
        branch_count: Number(row.branch_count),
        percentage_of_rows: Number(row.percentage_of_rows),
        size_kb: Number(row.size_kb),
      }));

      return IndexOperationalInfoSchema.parse({
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    }),

  getUserSummaryStats: adminProcedure
    .input(UserPaginationInputSchema)
    .output(UserIndexOperationalInfoSchema)
    .query(async ({ input }) => {
      const { page, pageSize, sortBy, sortOrder } = input;
      const offset = (page - 1) * pageSize;

      // Map frontend field names to SQL column names
      const sortColumnMap: Record<string, string> = {
        user_email: 'user_email',
        chunk_count: 'chunk_count',
        project_count: 'project_count',
        branch_count: 'branch_count',
        percentage_of_rows: 'percentage_of_rows',
        size_kb: 'size_kb',
        last_modified: 'last_modified',
      };
      const sortColumn = sortColumnMap[sortBy] || 'size_kb';
      // Implementation for getting operational info for user indexes only
      const manifestTableName = getTableName(code_indexing_manifest);
      const usersTableName = getTableName(kilocode_users);
      const userIdColumn = code_indexing_manifest.kilo_user_id.name;
      const userEmailColumn = kilocode_users.google_user_email.name;

      // Get total count
      const { rows: countRows } = await db.execute(sql`
      SELECT COUNT(DISTINCT ${sql.identifier(userIdColumn)})::int as total
      FROM ${sql.identifier(manifestTableName)}
      WHERE ${sql.identifier(userIdColumn)} IS NOT NULL
    `);
      const total = Number(countRows[0]?.total || 0);

      // Get paginated data
      const { rows } = await db.execute(sql`
      WITH table_stats AS (
          SELECT
              ${sql.identifier(userIdColumn)},
              SUM(chunk_count) as chunk_count,
              SUM(chunk_count) * 100.0 / SUM(SUM(chunk_count)) OVER () as percentage,
              COUNT(DISTINCT project_id) as project_count,
              COUNT(DISTINCT git_branch) as branch_count,
              MAX(created_at) as last_modified
          FROM ${sql.identifier(manifestTableName)}
          WHERE ${sql.identifier(userIdColumn)} IS NOT NULL
          GROUP BY ${sql.identifier(userIdColumn)}
      ),
      total_chunks AS (
          SELECT
              SUM(chunk_count) as total_chunks
          FROM ${sql.identifier(manifestTableName)}
          WHERE ${sql.identifier(userIdColumn)} IS NOT NULL
      )
      SELECT
          ts.${sql.identifier(userIdColumn)},
          u.${sql.identifier(userEmailColumn)} as user_email,
          ts.chunk_count::int,
          ts.project_count::int,
          ts.branch_count::int,
          ROUND(ts.percentage, 2) as percentage_of_rows,
          ${chunkCountToSizeKbSql(sql.raw('ts.chunk_count'))} as size_kb,
          ts.last_modified
      FROM table_stats ts
      CROSS JOIN total_chunks
      LEFT JOIN ${sql.identifier(usersTableName)} u ON ts.${sql.identifier(userIdColumn)} = u.id
      ORDER BY ${sql.identifier(sortColumn)} ${sql.raw(sortOrder.toUpperCase())}
      LIMIT ${pageSize}
      OFFSET ${offset};
      `);

      // Convert BigInt and numeric string values to numbers for JSON serialization
      const items = rows.map(row => ({
        ...row,
        chunk_count: Number(row.chunk_count),
        project_count: Number(row.project_count),
        branch_count: Number(row.branch_count),
        percentage_of_rows: Number(row.percentage_of_rows),
        size_kb: Number(row.size_kb),
      }));

      return UserIndexOperationalInfoSchema.parse({
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    }),

  getClusterStatus: adminProcedure.output(ClusterStatusSchema).query(async () => {
    // Fetch telemetry data from Qdrant with details_level=100
    const telemetryUrl = `https://${QDRANT_HOST}/telemetry?details_level=1`;
    const telemetryResponse = await fetch(telemetryUrl, {
      method: 'GET',
      headers: {
        'api-key': QDRANT_API_KEY || '',
      },
    });

    if (!telemetryResponse.ok) {
      throw new Error(`Failed to fetch telemetry: ${telemetryResponse.statusText}`);
    }

    const telemetryData = await telemetryResponse.json();

    // Extract memory statistics
    const memory = telemetryData.result?.memory || {};
    const memoryActiveBytes = memory.active_bytes || 0;
    const memoryAllocatedBytes = memory.allocated_bytes || 0;
    const memoryMetadataBytes = memory.metadata_bytes || 0;
    const memoryResidentBytes = memory.resident_bytes || 0;
    const memoryRetainedBytes = memory.retained_bytes || 0;

    // Extract system information
    const system = telemetryData.result?.app?.system || {};
    const distribution = system.distribution || 'unknown';
    const distributionVersion = system.distribution_version || 'unknown';
    const isDocker = system.is_docker || false;
    const cpuCores = system.cores || 0;
    // Use hard-coded cluster RAM size from environment variable (in GB)
    // The API's ram_size is unreliable, so we use our known cluster tier sizes
    const totalRamBytes = QDRANT_CLUSTER_RAM_GB * 1024 * 1024 * 1024;
    const totalDiskBytes = system.disk_size || 0;
    const cpuFlags = system.cpu_flags || 'unknown';

    // Extract app information
    const app = telemetryData.result?.app || {};
    const qdrantVersion = app.version || 'unknown';
    const startupTime = app.startup || '';

    // Calculate uptime
    const uptime = startupTime
      ? `${Math.floor((Date.now() - new Date(startupTime).getTime()) / (1000 * 60 * 60 * 24))} days`
      : 'unknown';

    // Extract cluster information
    const cluster = telemetryData.result?.cluster?.status || {};
    const clusterRole = cluster.role || 'unknown';
    const clusterPeers = cluster.number_of_peers || 0;
    const clusterPendingOperations = cluster.pending_operations || 0;
    const consensusStatus = cluster.consensus_thread_status?.consensus_thread_status || 'unknown';

    // Get main collection stats (org-code-indexing)
    // Note: The telemetry response doesn't include collection names in the collections array
    // We need to get this info from the cluster info or use the total vectors count
    const collectionsData = telemetryData.result?.collections || {};
    const collections = collectionsData.collections || [];

    // Sum up all vectors across collections as a fallback
    // In the actual response, collections don't have id/name fields
    let mainCollectionPoints = 0;
    let mainCollectionOptimizersStatus = 'unknown';

    if (collections.length > 0) {
      // Use the first/main collection's data
      const firstCollection = collections[0];
      mainCollectionPoints = firstCollection?.vectors || 0;
      mainCollectionOptimizersStatus = firstCollection?.optimizers_status || 'unknown';
    }

    // Get total PostgreSQL rows from manifest table
    const manifestTableName = getTableName(code_indexing_manifest);
    const { rows } = await db.execute(sql`
      SELECT SUM(chunk_count)::int as total_rows
      FROM ${sql.identifier(manifestTableName)}
    `);

    const totalPostgresRows = Number(rows[0]?.total_rows || 0);

    return ClusterStatusSchema.parse({
      totalPostgresRows,
      distribution,
      distributionVersion,
      isDocker,
      cpuCores,
      totalRamBytes,
      totalDiskBytes,
      cpuFlags,
      memoryActiveBytes,
      memoryAllocatedBytes,
      memoryMetadataBytes,
      memoryResidentBytes,
      memoryRetainedBytes,
      mainCollectionPoints,
      mainCollectionOptimizersStatus,
      clusterRole,
      clusterPeers,
      clusterPendingOperations,
      consensusStatus,
      qdrantVersion,
      uptime,
    });
  }),
});
