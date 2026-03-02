import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException, setTags } from '@sentry/nextjs';
import * as z from 'zod';
import { createTRPCContext } from '@/lib/trpc/init';
import { sentryLogger } from '@/lib/utils.server';
import { streamChunks, type ChunkMetadata } from '@/lib/managed-index-chunking';
import { getIndexStorage } from '@/lib/code-indexing/storage';
import type { ChunkWithMetadata } from '@/lib/code-indexing/types';
import { db } from '@/lib/drizzle';
import { code_indexing_manifest } from '@kilocode/db/schema';
import { getCodeIndexOrganizationId } from '@/routers/code-indexing/code-indexing-router';
import { trackCodeIndexingUpsert } from '@/lib/code-indexing/posthog-tracking';
import { createFlexibleAIAttributionTracker } from '@/lib/ai-attribution-service';

// Same constants as in the router
const MAX_CHUNK_LENGTH = 8192;
const errorLogger = sentryLogger('code-indexing-upsert-by-file', 'error');

// Batch size for embedding generation
const BATCH_SIZE = 4;

// Zod schema for form data validation
const FormDataSchema = z.object({
  file: z.instanceof(File, { message: 'file must be a File object' }),
  organizationId: z.string().optional().nullable(),
  projectId: z.string().min(1, { message: 'projectId is required' }),
  filePath: z.string().min(1, { message: 'filePath is required' }),
  fileHash: z.string().min(1, { message: 'fileHash is required' }),
  gitBranch: z.string().default('main'),
  isBaseBranch: z
    .string()
    .transform(val => val === 'true')
    .default(true),
});

type ErrorResponse = { error: string; message?: string };
type SuccessResponse = { success: true; chunksProcessed: number };

/**
 * PUT /api/code-indexing/upsert-by-file
 *
 * Handles multipart file upload for code indexing with server-side chunking.
 * This endpoint:
 * 1. Receives a file via multipart/form-data along with metadata
 * 2. Deletes existing chunks for the file/org/branch combination
 * 3. Streams the file content through the chunker
 * 4. Generates embeddings for each chunk with controlled concurrency
 * 5. Inserts chunks into the database
 *
 * Form fields:
 * - file: The file to index (required)
 * - organizationId: UUID of the organization (required)
 * - projectId: Project identifier (required)
 * - filePath: Relative file path from workspace root (required)
 * - fileHash: SHA-256 hash of the file content (required)
 * - gitBranch: Git branch name (default: 'main')
 * - isBaseBranch: Whether this is a base branch (default: true)
 */
export async function PUT(
  request: NextRequest
): Promise<NextResponse<ErrorResponse | SuccessResponse>> {
  try {
    // Create tRPC context for authentication
    const ctx = await createTRPCContext();

    // Parse multipart form data
    let formData: FormData | undefined;
    try {
      formData = await request.formData();
    } catch (e) {
      console.warn('Unabled to parse form data', e);
      return NextResponse.json(
        { error: 'Invalid form data', message: 'Unable to parse form data' },
        { status: 400 }
      );
    }

    // Extract form fields
    const rawData = {
      file: formData.get('file'),
      organizationId: formData.get('organizationId'),
      projectId: formData.get('projectId'),
      filePath: formData.get('filePath'),
      fileHash: formData.get('fileHash'),
      gitBranch: formData.get('gitBranch') || 'main',
      isBaseBranch: formData.get('isBaseBranch') || 'true',
    };

    // Validate with Zod
    const validationResult = FormDataSchema.safeParse(rawData);

    if (!validationResult.success) {
      const errors = validationResult.error.issues.map(
        (err: z.core.$ZodIssue) => `${err.path.join('.')}: ${err.message}`
      );
      console.log('zod errors', errors);
      return NextResponse.json(
        { error: 'Validation failed', message: errors.join(', ') },
        { status: 400 }
      );
    }

    const { file, projectId, filePath, fileHash, gitBranch, isBaseBranch } = validationResult.data;

    const organizationId = await getCodeIndexOrganizationId(ctx, {
      organizationId: validationResult.data.organizationId,
    });

    // Create storage instance with default provider and collection
    const storage = getIndexStorage();

    setTags({
      projectId,
      gitBranch,
      filePath,
    });

    let chunksProcessed = 0;

    try {
      // Delete existing chunks for this file/org/branch combination
      await storage.deleteByFilePath({
        organizationId,
        projectId,
        gitBranch,
        filePath,
      });

      // Prepare metadata for chunking
      const metadata: ChunkMetadata = {
        filePath,
        organizationId,
        projectId,
        gitBranch,
        isBaseBranch,
      };

      // Create tracker for AI attribution stats (fetches attributions before streaming)
      // On base branch: don't filter by branch so we match AI lines from any branch (merged code)
      // On feature branch: filter by this specific branch only
      const aiAttributionTracker = await createFlexibleAIAttributionTracker({
        organization_id: organizationId,
        project_id: projectId,
        file_path: filePath,
        branch: isBaseBranch ? undefined : gitBranch,
      });

      // Convert file to text stream
      const fileStream = file.stream();
      const textStream = fileStream.pipeThrough(new TextDecoderStream());

      // Collect chunks into batches for efficient embedding generation
      let batch: ChunkWithMetadata[] = [];

      const userId = validationResult.data.organizationId ? null : ctx.user.id;

      // Helper function to process a batch
      const processBatch = async (batchToProcess: ChunkWithMetadata[]): Promise<number> => {
        return await storage.processBatch(batchToProcess);
      };

      try {
        // Stream chunks and collect them into batches
        // Using for-await-of ensures the async generator is fully consumed
        for await (const chunk of streamChunks(textStream, metadata)) {
          // don't attempt to embed empty chunks - it causes an openAI API error
          if (!chunk.codeChunk.length) {
            continue;
          }

          // Process AI attribution stats for this chunk
          aiAttributionTracker.processChunk(chunk);

          // Truncate chunk if it exceeds max length
          const text = chunk.codeChunk.substring(0, MAX_CHUNK_LENGTH);

          batch.push({
            text,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            organizationId,
            userId,
            projectId,
            filePath,
            fileHash,
            gitBranch,
            isBaseBranch,
          });

          // Process batch when it reaches the batch size
          if (batch.length >= BATCH_SIZE) {
            chunksProcessed += batch.length;
            await processBatch(batch);
            batch = [];
          }
        }

        // Process any remaining chunks in the final batch
        if (batch.length > 0) {
          chunksProcessed += batch.length;
          await processBatch(batch);
        }
      } finally {
        // The stream should be automatically closed when the async generator completes
        // No explicit cleanup needed as the generator's finally block handles reader.releaseLock()
      }

      // Get final AI attribution stats
      const { totalLines, totalAiLines } = aiAttributionTracker.getStats();

      // Upsert manifest entry for this file
      // we upsert because there could be a race between multiple uploads of the same file
      await db
        .insert(code_indexing_manifest)
        .values({
          organization_id: organizationId,
          kilo_user_id: userId,
          project_id: projectId,
          git_branch: gitBranch,
          file_hash: fileHash,
          file_path: filePath,
          chunk_count: chunksProcessed,
          total_lines: totalLines,
          total_ai_lines: totalAiLines,
        })
        .onConflictDoUpdate({
          target: [
            code_indexing_manifest.organization_id,
            code_indexing_manifest.kilo_user_id,
            code_indexing_manifest.project_id,
            code_indexing_manifest.file_path,
            code_indexing_manifest.git_branch,
          ],
          set: {
            chunk_count: chunksProcessed,
            file_hash: fileHash,
            total_lines: totalLines,
            total_ai_lines: totalAiLines,
          },
        });

      // Track successful upsert event in PostHog
      trackCodeIndexingUpsert({
        distinctId: ctx.user.google_user_email,
        organizationId,
        userId: ctx.user.id,
        projectId,
        filePath,
        gitBranch,
        isBaseBranch,
        chunksProcessed,
        fileSizeBytes: file.size,
        success: true,
      });

      return NextResponse.json({
        success: true,
        chunksProcessed,
      });
    } catch (error) {
      // Track failed upsert event in PostHog
      trackCodeIndexingUpsert({
        distinctId: ctx.user.google_user_email,
        organizationId,
        userId: ctx.user.id,
        projectId,
        filePath,
        gitBranch,
        isBaseBranch,
        chunksProcessed,
        fileSizeBytes: file.size,
        success: false,
      });

      // Re-throw the error to be caught by the outer try-catch
      throw error;
    }
  } catch (error) {
    // Outer catch for early failures (auth, form parsing, validation)
    // These don't need PostHog tracking as they're pre-processing failures
    console.log('error', error);
    // Log to Sentry
    captureException(error, {
      extra: {
        url: request.url,
        method: request.method,
      },
    });

    if (error instanceof Error) {
      errorLogger(error.message);
      return NextResponse.json(
        { error: 'Internal Server Error', message: error.message },
        { status: 500 }
      );
    }

    errorLogger('Unknown error during file upload and indexing');
    return NextResponse.json(
      { error: 'Internal Server Error', message: 'An error occurred while processing the file' },
      { status: 500 }
    );
  }
}
