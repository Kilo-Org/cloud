import type { EmbeddingService } from '@/lib/embeddings/embedding-providers';
import { getMilvusClient } from './milvus';
import type {
  ChunkWithMetadata,
  DeleteByFilePathParams,
  DeleteParams,
  SearchParams,
  SearchResult,
  GetManifestParams,
  ManifestResult,
} from './types';
import { db } from '@/lib/drizzle';
import { code_indexing_manifest } from '@kilocode/db/schema';
import { eq, and, isNull, sql, inArray, lt } from 'drizzle-orm';
import { createHash } from 'crypto';

export const DEFAULT_COLLECTION_NAME = 'org_code_indexing';

// Helper to escape string values for Milvus filter expressions
function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class MilvusIndexStorage {
  private collectionName: string;
  private scoreThreshold: number;

  constructor(
    private embeddingService: EmbeddingService,
    collectionName: string = DEFAULT_COLLECTION_NAME
  ) {
    this.collectionName = collectionName;
    // Set score threshold based on embedding provider
    // OpenAI embeddings have different score distribution than Mistral
    this.scoreThreshold = embeddingService.getProvider() === 'openai' ? 0.3 : 0.6;
  }

  async deleteByFilePath(params: DeleteByFilePathParams): Promise<void> {
    // Build filter expression for Milvus
    const filter = `organization_id == "${escapeFilterValue(params.organizationId)}" && project_id == "${escapeFilterValue(params.projectId)}" && git_branch == "${escapeFilterValue(params.gitBranch)}" && file_path == "${escapeFilterValue(params.filePath)}"`;

    const start = Date.now();
    // Delete points matching the file path
    await getMilvusClient().delete({
      collection_name: this.collectionName,
      filter,
    });

    console.log(`[milvus] - deleted file ${params.filePath} in ${Date.now() - start}ms`);

    // Delete from manifest table
    await db
      .delete(code_indexing_manifest)
      .where(
        and(
          params.organizationId
            ? eq(code_indexing_manifest.organization_id, params.organizationId)
            : isNull(code_indexing_manifest.organization_id),
          eq(code_indexing_manifest.project_id, params.projectId),
          eq(code_indexing_manifest.git_branch, params.gitBranch),
          eq(code_indexing_manifest.file_path, params.filePath)
        )
      );
  }

  async delete(params: DeleteParams): Promise<number> {
    // Build filter expression parts
    const filterParts: string[] = [
      `organization_id == "${escapeFilterValue(params.organizationId)}"`,
      `project_id == "${escapeFilterValue(params.projectId)}"`,
    ];

    if (params.gitBranch) {
      filterParts.push(`git_branch == "${escapeFilterValue(params.gitBranch)}"`);
    }

    if (params.filePaths && params.filePaths.length > 0) {
      // Build IN clause for file paths
      const escapedPaths = params.filePaths.map(p => `"${escapeFilterValue(p)}"`).join(', ');
      filterParts.push(`file_path in [${escapedPaths}]`);
    }

    const filter = filterParts.join(' && ');

    const start = Date.now();
    await getMilvusClient().delete({
      collection_name: this.collectionName,
      filter,
    });

    console.log(
      `[milvus] - deleted ${params.filePaths?.length || 0} files in ${Date.now() - start}ms`
    );

    // Delete from manifest table
    const manifestConditions = [
      params.organizationId
        ? eq(code_indexing_manifest.organization_id, params.organizationId)
        : isNull(code_indexing_manifest.organization_id),
      eq(code_indexing_manifest.project_id, params.projectId),
    ];

    if (params.gitBranch) {
      manifestConditions.push(eq(code_indexing_manifest.git_branch, params.gitBranch));
    }

    if (params.filePaths && params.filePaths.length > 0) {
      manifestConditions.push(inArray(code_indexing_manifest.file_path, params.filePaths));
    }

    await db.delete(code_indexing_manifest).where(and(...manifestConditions));

    return params.filePaths?.length || 0;
  }

  async deleteByOrganizationBeforeDate(params: {
    organizationId: string;
    beforeDate: Date;
  }): Promise<void> {
    // Build filter expression for Milvus
    // created_at is stored as unix timestamp (milliseconds)
    const beforeTimestamp = params.beforeDate.getTime();
    const filter = `organization_id == "${escapeFilterValue(params.organizationId)}" && created_at < ${beforeTimestamp}`;

    // Delete points from Milvus where organization_id matches and created_at is before the supplied date
    await getMilvusClient().delete({
      collection_name: this.collectionName,
      filter,
    });

    // Delete from manifest table where created_at is before the supplied date
    await db
      .delete(code_indexing_manifest)
      .where(
        and(
          eq(code_indexing_manifest.organization_id, params.organizationId),
          lt(code_indexing_manifest.created_at, params.beforeDate.toISOString())
        )
      );
  }

  async processBatch(chunks: ChunkWithMetadata[]): Promise<number> {
    if (chunks.length === 0) return 0;
    const created_at = Date.now();

    // Extract texts for embedding
    const texts = chunks.map(chunk => chunk.text);

    // Generate embeddings for the entire batch
    const { embeddings } = await this.embeddingService.embedMany(texts);

    // Prepare data for Milvus upsert
    const data = chunks.map((chunk, index) => {
      // Generate deterministic ID using MD5 hash of organization_id + file_path + text + branch
      const idString = `${chunk.organizationId}|${chunk.projectId}|${chunk.filePath}|${chunk.text}|${chunk.gitBranch}`;
      const id = createHash('md5').update(idString).digest('hex');

      return {
        id,
        vector: embeddings[index],
        organization_id: chunk.organizationId,
        project_id: chunk.projectId,
        file_path: chunk.filePath,
        file_hash: chunk.fileHash,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        git_branch: chunk.gitBranch,
        created_at,
      };
    });

    const start = Date.now();
    // Upsert data to Milvus
    await getMilvusClient().upsert({
      collection_name: this.collectionName,
      data,
    });

    console.log(`[milvus] - inserted ${chunks.length} chunks in ${Date.now() - start}ms`);

    return chunks.length;
  }

  async search(params: SearchParams): Promise<SearchResult[]> {
    // Create embedding from search query
    const { embedding } = await this.embeddingService.embedSingle(params.query);

    // Build filter expression parts
    const filterParts: string[] = [
      `organization_id == "${escapeFilterValue(params.organizationId)}"`,
      `project_id == "${escapeFilterValue(params.projectId)}"`,
    ];

    // Add branch filter: use OR condition if preferBranch is specified, otherwise just fallbackBranch
    if (params.preferBranch) {
      filterParts.push(
        `(git_branch == "${escapeFilterValue(params.preferBranch)}" || git_branch == "${escapeFilterValue(params.fallbackBranch)}")`
      );
    } else {
      filterParts.push(`git_branch == "${escapeFilterValue(params.fallbackBranch)}"`);
    }

    const filter = filterParts.join(' && ');

    // Perform search query
    // Fetch more results than needed to allow for grouping by file_path
    const start = Date.now();
    const searchResults = await getMilvusClient().search({
      collection_name: this.collectionName,
      data: [embedding],
      limit: 200,
      filter,
      output_fields: ['file_path', 'start_line', 'end_line', 'git_branch'],
    });
    // Process results and deduplicate by file path with preference logic
    const resultMap = new Map<string, SearchResult>();
    const preferBranch = params.preferBranch;

    for (const point of searchResults.results) {
      const filePath = String(point.file_path);
      const gitBranch = String(point.git_branch);
      const score = point.score ?? 0;
      const fromPreferredBranch = preferBranch ? gitBranch === preferBranch : false;

      // Skip results below score threshold
      if (score < this.scoreThreshold) {
        continue;
      }

      // Skip if file is in excludeFiles list
      if (params.excludeFiles.includes(filePath)) {
        continue;
      }

      // Apply path filter if provided
      if (params.path && params.path !== 'all' && params.path !== '/') {
        const pathLower = params.path.toLowerCase();
        if (!filePath.toLowerCase().startsWith(pathLower)) {
          continue;
        }
      }

      // Deduplicate by file path with preference logic:
      // - If result from preferred branch, always use it (or use if higher score)
      // - If result from fallback branch, only use if no preferred result exists or if higher score
      const existing = resultMap.get(filePath);
      if (!existing) {
        resultMap.set(filePath, {
          id: String(point.id),
          filePath,
          startLine: Number(point.start_line),
          endLine: Number(point.end_line),
          score,
          gitBranch,
          fromPreferredBranch,
        });
      } else {
        // Prefer results from preferred branch, or higher score if same branch preference
        const shouldReplace =
          (fromPreferredBranch && !existing.fromPreferredBranch) ||
          (fromPreferredBranch === existing.fromPreferredBranch && score > existing.score);

        if (shouldReplace) {
          resultMap.set(filePath, {
            id: String(point.id),
            filePath,
            startLine: Number(point.start_line),
            endLine: Number(point.end_line),
            score,
            gitBranch,
            fromPreferredBranch,
          });
        }
      }
    }

    // Sort by score and return top 50
    const finalResults = Array.from(resultMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);

    console.log(
      `[milvus] - search found ${finalResults.length} results in ${Date.now() - start}ms`
    );

    return finalResults;
  }

  async getManifest(params: GetManifestParams): Promise<ManifestResult> {
    // Query the code_indexing_manifest table to get file_hash -> file_path mapping and AI line stats
    const result = await db.execute(sql`
      SELECT
        json_object_agg(file_hash, file_path) as files,
        COALESCE(SUM(total_lines), 0)::int as total_lines,
        COALESCE(SUM(total_ai_lines), 0)::int as total_ai_lines
      FROM (
        SELECT DISTINCT ON (file_path)
          file_hash,
          file_path,
          total_lines,
          total_ai_lines
        FROM ${code_indexing_manifest}
        WHERE
          ${
            params.organizationId
              ? sql`organization_id = ${params.organizationId}`
              : sql`organization_id IS NULL`
          } AND
          project_id = ${params.projectId} AND
          git_branch = ${params.gitBranch} AND
          file_hash IS NOT NULL
        ORDER BY file_path, file_hash
      ) AS distinct_files
    `);

    // Extract files from the result
    const files: Record<string, string> = (result.rows[0]?.files as Record<string, string>) ?? {};

    // Calculate totals
    const totalFiles = Object.keys(files).length;
    const totalLines = Number(result.rows[0]?.total_lines ?? 0);
    const totalAILines = Number(result.rows[0]?.total_ai_lines ?? 0);
    const percentageOfAILines = totalLines > 0 ? (totalAILines / totalLines) * 100 : 0;

    // Find most recent update
    const lastUpdated = new Date().toISOString();

    return {
      organizationId: params.organizationId,
      projectId: params.projectId,
      gitBranch: params.gitBranch,
      files,
      totalFiles,
      lastUpdated,
      totalLines,
      totalAILines,
      percentageOfAILines,
    };
  }
}
