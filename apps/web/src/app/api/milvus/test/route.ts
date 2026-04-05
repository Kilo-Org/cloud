import { getMilvusClient } from '@/lib/code-indexing/milvus';
import { MilvusIndexStorage, DEFAULT_COLLECTION_NAME } from '@/lib/code-indexing/milvus-storage';
import type { ChunkWithMetadata } from '@/lib/code-indexing/types';
import { createEmbeddingService } from '@/lib/embeddings/embedding-providers';
import { NextResponse, type NextRequest } from 'next/server';

const TEST_ORG_ID = 'test-org';
const TEST_PROJECT_ID = 'test-project';
const TEST_GIT_BRANCH = 'main';

// ============================================================================
// Route handler
// ============================================================================
export async function GET(request: NextRequest) {
  try {
    const client = getMilvusClient();
    const hasCollection = await client.hasCollection({
      collection_name: DEFAULT_COLLECTION_NAME,
    });

    const embed = request.nextUrl.searchParams.get('embed');
    const search = request.nextUrl.searchParams.get('search');

    const embeddingService = createEmbeddingService();
    const storage = new MilvusIndexStorage(embeddingService);

    let embedResult: { success: boolean; count?: number; error?: string } | undefined;

    let searchResult:
      | {
          success: boolean;
          resultCount?: number;
          results?: unknown[];
          error?: string;
        }
      | undefined;

    if (embed) {
      const chunk: ChunkWithMetadata = {
        text: embed,
        startLine: 1,
        endLine: 1,
        organizationId: TEST_ORG_ID,
        userId: null,
        projectId: TEST_PROJECT_ID,
        filePath: 'test-file.txt',
        fileHash: 'test-hash',
        gitBranch: TEST_GIT_BRANCH,
        isBaseBranch: true,
      };

      try {
        const count = await storage.processBatch([chunk]);
        embedResult = {
          success: true,
          count,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to write to Milvus', error);
        embedResult = { success: false, error: message };
      }
    }

    if (search) {
      try {
        const results = await storage.search({
          query: search,
          organizationId: TEST_ORG_ID,
          projectId: TEST_PROJECT_ID,
          fallbackBranch: TEST_GIT_BRANCH,
          excludeFiles: [],
        });

        searchResult = {
          success: true,
          resultCount: results.length,
          results,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to search Milvus', error);
        searchResult = { success: false, error: message };
      }
    }

    return NextResponse.json({
      success: true,
      collectionExists: hasCollection.value,
      collectionName: DEFAULT_COLLECTION_NAME,
      ...(embedResult && { embedResult }),
      ...(searchResult && { searchResult }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
