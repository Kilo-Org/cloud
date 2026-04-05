/**
 * Client module for communicating with the AI Attribution Worker service
 */

import crypto from 'crypto';
import { AI_ATTRIBUTION_ADMIN_SECRET } from '@/lib/config.server';
import 'server-only';
import { z } from 'zod';

const AI_ATTRIBUTION_SERVICE_URL = 'https://ai-attribution.kiloapps.io';
// If you want to target the local attribution service, you can use this:
// const AI_ATTRIBUTION_SERVICE_URL = 'http://localhost:8787';

// Schema for debug data response from the worker
const LineRecord = z.object({
  id: z.number(),
  attributions_metadata_id: z.number(),
  line_number: z.number(),
  line_hash: z.string(),
});

const AttributionRecord = z.object({
  id: z.number(),
  user_id: z.string(),
  organization_id: z.string().nullable(),
  project_id: z.string(),
  branch: z.string(),
  file_path: z.string(),
  status: z.string(),
  task_id: z.string().nullable(),
  created_at: z.string(),
  lines_added: z.array(LineRecord),
  lines_removed: z.array(LineRecord),
});

const DebugDataSummary = z.object({
  total_attributions: z.number(),
  total_lines_added: z.number(),
  total_lines_removed: z.number(),
  by_status: z.record(z.string(), z.number()),
  by_branch: z.record(z.string(), z.number()),
});

const DebugDataResponse = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    data: z.object({
      doKey: z.string(),
      attributions: z.array(AttributionRecord),
      summary: DebugDataSummary,
    }),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

export type AIAttributionDebugData = z.infer<typeof DebugDataResponse>;

const DeleteAttributionResponse = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    data: z.object({
      deleted: z.literal(true),
      attribution_id: z.number(),
    }),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

export type DeleteAttributionResult = z.infer<typeof DeleteAttributionResponse>;

// Schema for attribution events (used by flexible retention)
const AttributionEvent = z.object({
  id: z.number(),
  taskId: z.string().nullable(),
  lineHashes: z.array(z.string()),
});
type AttributionEvent = z.infer<typeof AttributionEvent>;

/**
 * Compute a SHA-1 hash of a line's content for AI attribution matching.
 * Normalizes the content by:
 * 1. Removing line endings for consistent hashing across platforms
 * 2. Trimming all leading/trailing whitespace to handle indentation changes
 *
 * IMPORTANT: This must match the hashing algorithm in the VS Code extension!
 */
function computeLineHash(lineContent: string): string {
  // 1. Remove line endings for consistent hashing across platforms
  // 2. Trim all leading/trailing whitespace to handle indentation changes
  const normalized = lineContent.replace(/\r?\n$/, '').trim();
  return crypto.createHash('sha1').update(normalized, 'utf8').digest('hex');
}

type GetFileAIAttributionsParams = {
  organization_id: string;
  project_id: string;
  file_path: string;
  branch?: string;
};

const GetAttributionEventsResponse = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    data: z.object({
      events: z.array(AttributionEvent),
    }),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

type AIAttributionTrackerParams = {
  organization_id: string;
  project_id: string;
  file_path: string;
  branch?: string;
};

/**
 * Fetches AI attribution events for a specific file from the AI Attribution Worker.
 * Returns an array of attribution events, each containing ordered line hashes.
 * This is the preferred method for flexible retention calculation using LCS.
 *
 * @param params - The file identification parameters
 * @returns Array of attribution events with ordered line hashes
 * @throws Error if the request fails or returns an error response
 */
export async function getFileAttributionEvents(
  params: GetFileAIAttributionsParams
): Promise<AttributionEvent[]> {
  if (!AI_ATTRIBUTION_ADMIN_SECRET) {
    throw new Error('AI_ATTRIBUTION_ADMIN_SECRET is not configured');
  }

  const url = new URL('/admin/attribution-events', AI_ATTRIBUTION_SERVICE_URL);
  url.searchParams.set('organization_id', params.organization_id);
  url.searchParams.set('project_id', params.project_id);
  url.searchParams.set('file_path', params.file_path);
  if (params.branch) {
    url.searchParams.set('branch', params.branch);
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Admin-Secret': AI_ATTRIBUTION_ADMIN_SECRET,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI Attribution service error (${response.status}): ${errorText}`);
  }

  const json = GetAttributionEventsResponse.parse(await response.json());

  if (!json.success) {
    throw new Error(`AI Attribution service error: ${json.error}`);
  }

  return json.data.events;
}

/**
 * Returns the specific indices in the file that match the AI history using LCS.
 * This is used by the Attribution Bitmap approach to "paint" which file lines
 * are AI-attributed.
 *
 * @param aiHashes - Ordered hashes from an AI attribution event
 * @param fileHashes - Ordered hashes from the current file
 * @param options - Configuration options
 * @returns Array of file indices that match the AI hashes (in order)
 */
function getAttributedIndices(
  aiHashes: string[],
  fileHashes: string[],
  options: {
    /** Maximum lines to look ahead when searching for a match (default: 50) */
    lookaheadLimit?: number;
  } = {}
): number[] {
  const { lookaheadLimit = 50 } = options;

  let aiIndex = 0;
  let fileIndex = 0;
  const matchedIndices: number[] = [];

  while (aiIndex < aiHashes.length && fileIndex < fileHashes.length) {
    const currentAiHash = aiHashes[aiIndex];

    if (currentAiHash === fileHashes[fileIndex]) {
      // MATCH: Record the file index
      matchedIndices.push(fileIndex);
      aiIndex++;
      fileIndex++;
    } else {
      // MISMATCH: User might have inserted lines.
      // Scan ahead in file to see if the current AI line appears later.
      let foundAhead = false;

      for (let k = 1; k <= lookaheadLimit && fileIndex + k < fileHashes.length; k++) {
        if (fileHashes[fileIndex + k] === currentAiHash) {
          // Found it! Skip to that position
          fileIndex += k;
          foundAhead = true;
          break;
        }
      }

      if (foundAhead) {
        continue;
      } else {
        // The AI line is genuinely missing (deleted).
        aiIndex++;
      }
    }
  }

  return matchedIndices;
}

/**
 * Creates a flexible AI attribution tracker using the Attribution Bitmap approach.
 * This tracker is resilient to line insertions, deletions, shifts, and reordering.
 *
 * The key insight is to track which **file indices** are AI-attributed rather than
 * counting matches. Each attribution event "paints" indices on a bitmap (Set).
 * This guarantees the count never exceeds the file's total lines.
 *
 * Benefits:
 * - Idempotent: If two events match the same line, it's only counted once
 * - Reordering resilient: If user moves AI code, each event finds its lines
 * - Accurate coverage: Answers "Is this line backed by any AI history?"
 */
export async function createFlexibleAIAttributionTracker(params: AIAttributionTrackerParams) {
  let attributionEvents: AttributionEvent[] | null = null;
  // Use a Set to track which line numbers we've already processed (for deduplication)
  const processedLines = new Set<number>();
  // Collect hashes in order as we encounter them
  const fileHashes: string[] = [];

  // Fetch AI attribution events for this file
  try {
    attributionEvents = await getFileAttributionEvents(params);
  } catch (error) {
    // Log but don't fail - AI attribution tracking is optional
    console.warn('Failed to fetch AI attribution events, skipping AI line counting', {
      error: error instanceof Error ? error.message : String(error),
      ...params,
    });
  }

  return {
    /**
     * Process a chunk and collect file hashes.
     * We collect all hashes first and calculate attribution at the end.
     *
     * Note: Chunks may overlap (for embedding context), so we deduplicate by line number.
     * We use a Set to track processed lines and push hashes to a dense array in order.
     */
    processChunk(chunk: { codeChunk: string; startLine: number }) {
      if (!attributionEvents) return;

      const chunkLines = chunk.codeChunk.split('\n');

      for (let i = 0; i < chunkLines.length; i++) {
        const lineNumber = chunk.startLine + i;

        // Skip lines we've already processed (handles overlapping chunks)
        if (processedLines.has(lineNumber)) {
          continue;
        }
        processedLines.add(lineNumber);

        // Add hash to the dense array (in order of first encounter)
        fileHashes.push(computeLineHash(chunkLines[i]));
      }
    },

    /**
     * Get the final stats using the Attribution Bitmap approach.
     * Returns null values if no attribution events were found.
     *
     * Instead of counting matches per event and summing, we:
     * 1. Create a Set (bitmap) of file indices
     * 2. For each attribution event, find which file indices match via LCS
     * 3. "Paint" those indices onto the bitmap
     * 4. The bitmap size is the total AI lines (guaranteed ≤ file size)
     */
    getStats() {
      if (!attributionEvents || attributionEvents.length === 0) {
        return {
          totalLines: fileHashes.length || null,
          totalAiLines: null,
          retentionScore: null,
        };
      }

      const totalLines = fileHashes.length;

      if (totalLines === 0) {
        return {
          totalLines: null,
          totalAiLines: null,
          retentionScore: null,
        };
      }

      // Create the Attribution Bitmap - tracks which file indices are AI-attributed
      const attributedLineIndices = new Set<number>();

      // Process each attribution event and "paint" the bitmap
      for (const event of attributionEvents) {
        const matchedIndices = getAttributedIndices(event.lineHashes, fileHashes);

        // Paint the bitmap with matched indices
        for (const index of matchedIndices) {
          attributedLineIndices.add(index);
        }
      }

      // The bitmap size is the total AI lines
      // This is mathematically guaranteed to never exceed totalLines
      const aiLinesInFile = attributedLineIndices.size;

      return {
        totalLines,
        totalAiLines: aiLinesInFile,
        // Retention score: percentage of file that is AI-attributed
        retentionScore: aiLinesInFile / totalLines,
      };
    },
  };
}

/**
 * Fetches debug data for a specific file's Durable Object from the AI Attribution Worker.
 * This is used by the admin panel to display attribution debugging information.
 *
 * @param params - The file identification parameters
 * @returns The debug data including all attributions and summary statistics
 * @throws Error if the request fails or returns an error response
 */
export async function getAIAttributionDebugData(
  params: GetFileAIAttributionsParams
): Promise<AIAttributionDebugData> {
  if (!AI_ATTRIBUTION_ADMIN_SECRET) {
    throw new Error('AI_ATTRIBUTION_ADMIN_SECRET is not configured');
  }

  const url = new URL('/admin/debug-data', AI_ATTRIBUTION_SERVICE_URL);
  url.searchParams.set('organization_id', params.organization_id);
  url.searchParams.set('project_id', params.project_id);
  url.searchParams.set('file_path', params.file_path);
  if (params.branch) {
    url.searchParams.set('branch', params.branch);
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Admin-Secret': AI_ATTRIBUTION_ADMIN_SECRET,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI Attribution service error (${response.status}): ${errorText}`);
  }

  return DebugDataResponse.parse(await response.json());
}

type DeleteAttributionParams = {
  organization_id: string;
  project_id: string;
  file_path: string;
  attribution_id: number;
};

/**
 * Deletes a single attribution and its associated lines added/removed records.
 * This is used by the admin panel to clean up attribution data.
 *
 * @param params - The attribution identification parameters
 * @returns The result indicating whether the attribution was deleted
 * @throws Error if the request fails
 */
export async function deleteAIAttribution(
  params: DeleteAttributionParams
): Promise<DeleteAttributionResult> {
  if (!AI_ATTRIBUTION_ADMIN_SECRET) {
    throw new Error('AI_ATTRIBUTION_ADMIN_SECRET is not configured');
  }

  const url = new URL(`/admin/attribution/${params.attribution_id}`, AI_ATTRIBUTION_SERVICE_URL);
  url.searchParams.set('organization_id', params.organization_id);
  url.searchParams.set('project_id', params.project_id);
  url.searchParams.set('file_path', params.file_path);

  const response = await fetch(url.toString(), {
    method: 'DELETE',
    headers: {
      'X-Admin-Secret': AI_ATTRIBUTION_ADMIN_SECRET,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI Attribution service error (${response.status}): ${errorText}`);
  }

  return DeleteAttributionResponse.parse(await response.json());
}
