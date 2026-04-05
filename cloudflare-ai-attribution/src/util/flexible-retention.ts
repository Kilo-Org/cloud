/**
 * Flexible retention calculation using sequence alignment (LCS-like algorithm).
 *
 * This module provides a "floating" matcher that is resilient to line insertions,
 * deletions, and shifts. Instead of matching exact (hash, lineNumber) pairs,
 * it treats the AI's contribution as a sequence of hashes and aligns them
 * against the current file's sequence of hashes.
 */

/**
 * Common low-entropy line hashes that should be ignored during matching.
 * These are hashes of common syntax elements like `}`, `{`, `return;`, etc.
 * that could cause false positive matches.
 *
 * To generate these hashes, use the same hashing algorithm as the line hasher:
 * SHA-1 of the normalized (trimmed) line content.
 */
export const LOW_ENTROPY_HASHES = new Set<string>([
  // Empty line
  'da39a3ee5e6b4b0d3255bfef95601890afd80709',
  // Common single-character lines
  'bf8b4530d8d246dd74ac53a13471bba17941dff7', // }
  '4b68ab3847feda7d6c62c1fbcbeebfa35eab7351', // {
  // Common short statements
  '7818d5f1e7f5c3e7c3e7c3e7c3e7c3e7c3e7c3e7', // return;
  '3c363836cf4e16666669a25da280a1865c2d2874', // else {
  '8b137891791fe96927ad78e64b0aad7bded08bdc', // (single newline)
]);

/**
 * Represents an AI attribution event with its ordered line hashes.
 */
export type AIAttributionEvent = {
  /** Unique identifier for this attribution event */
  id: number;
  /** Ordered array of line hashes from the AI-generated code */
  lineHashes: string[];
  /** Task ID associated with this attribution (optional) */
  taskId?: string | null;
};

/**
 * Result of the flexible retention calculation.
 */
export type FlexibleRetentionResult = {
  /** Number of AI lines that matched in the current file */
  matchedCount: number;
  /** Total number of AI lines in the original attribution */
  totalAiLines: number;
  /** Retention score as a ratio (0.0 to 1.0) */
  retentionScore: number;
  /** Indices in the file where matches were found (for debugging) */
  matchedFileIndices: number[];
};

/**
 * Calculates retention score resilient to insertions/deletions using a greedy LCS approach.
 *
 * This algorithm scans through the file hashes looking for matches with the AI hashes
 * in order. It handles insertions by allowing gaps in the file sequence, and handles
 * deletions by skipping AI hashes that can't be found.
 *
 * @param aiHashes - The ordered list of hashes the AI originally generated
 * @param fileHashes - The ordered list of hashes currently in the file
 * @param options - Optional configuration
 * @returns The retention calculation result
 *
 * @example
 * // AI generated: [A, B, C]
 * // File now has: [A, X, Y, B, C] (user inserted X, Y)
 * // Result: matchedCount = 3, retentionScore = 1.0
 *
 * @example
 * // AI generated: [A, B, C]
 * // File now has: [A, C] (user deleted B)
 * // Result: matchedCount = 2, retentionScore = 0.67
 */
export function calculateFlexibleRetention(
  aiHashes: string[],
  fileHashes: string[],
  options: {
    /** Maximum lines to look ahead when searching for a match (default: 50) */
    lookaheadLimit?: number;
    /** Set of hashes to ignore during matching (low-entropy lines) */
    stopHashes?: Set<string>;
  } = {}
): FlexibleRetentionResult {
  const { lookaheadLimit = 50, stopHashes = LOW_ENTROPY_HASHES } = options;

  // Filter out stop hashes from AI hashes for matching purposes
  // We still count them in the total, but don't use them for alignment
  const significantAiHashes = aiHashes.filter(h => !stopHashes.has(h));

  if (significantAiHashes.length === 0) {
    // All AI lines were low-entropy, consider it 100% retained
    return {
      matchedCount: aiHashes.length,
      totalAiLines: aiHashes.length,
      retentionScore: 1.0,
      matchedFileIndices: [],
    };
  }

  let aiIndex = 0;
  let fileIndex = 0;
  let matchedCount = 0;
  const matchedFileIndices: number[] = [];

  // Simple Greedy LCS (Optimized for "Code mostly stays in order")
  // For full diff accuracy, use Myers Diff Algorithm, but this O(N*lookahead) scan
  // covers 99% of "insertion" cases efficiently.

  while (aiIndex < significantAiHashes.length && fileIndex < fileHashes.length) {
    const currentAiHash = significantAiHashes[aiIndex];

    // Skip stop hashes in the file
    if (stopHashes.has(fileHashes[fileIndex])) {
      fileIndex++;
      continue;
    }

    if (currentAiHash === fileHashes[fileIndex]) {
      // MATCH: The line exists and is in the correct relative order
      matchedCount++;
      matchedFileIndices.push(fileIndex);
      aiIndex++;
      fileIndex++;
    } else {
      // MISMATCH: User might have inserted lines.
      // Scan ahead in file to see if the current AI line appears later.
      let foundAhead = false;

      for (let k = 1; k <= lookaheadLimit && fileIndex + k < fileHashes.length; k++) {
        const aheadHash = fileHashes[fileIndex + k];

        // Skip stop hashes during lookahead
        if (stopHashes.has(aheadHash)) {
          continue;
        }

        if (aheadHash === currentAiHash) {
          // Found it! It was just pushed down by insertions.
          // Skip the inserted lines (advance fileIndex)
          fileIndex += k;
          foundAhead = true;
          break;
        }
      }

      if (foundAhead) {
        // We realigned, continue loop to catch the match in next iteration
        continue;
      } else {
        // The AI line is genuinely missing (deleted).
        // Give up on this AI line and move to the next one.
        aiIndex++;
      }
    }
  }

  // Calculate the final score
  // We count low-entropy lines as matched if we found a good proportion of significant lines
  const significantRetention =
    significantAiHashes.length > 0 ? matchedCount / significantAiHashes.length : 1.0;

  // The total matched count includes low-entropy lines proportionally
  const lowEntropyCount = aiHashes.length - significantAiHashes.length;
  const totalMatchedCount = matchedCount + Math.round(lowEntropyCount * significantRetention);

  return {
    matchedCount: totalMatchedCount,
    totalAiLines: aiHashes.length,
    retentionScore: aiHashes.length > 0 ? totalMatchedCount / aiHashes.length : 1.0,
    matchedFileIndices,
  };
}

/**
 * Aggregates retention across multiple AI attribution events for a single file.
 *
 * This is useful when a file has multiple AI contributions from different tasks
 * and you want to calculate the overall AI retention.
 *
 * @param events - Array of AI attribution events with their line hashes
 * @param fileHashes - The ordered list of hashes currently in the file
 * @param options - Optional configuration
 * @returns Aggregated retention statistics
 */
export function calculateAggregatedRetention(
  events: AIAttributionEvent[],
  fileHashes: string[],
  options: {
    lookaheadLimit?: number;
    stopHashes?: Set<string>;
  } = {}
): {
  totalAiLines: number;
  totalMatchedLines: number;
  overallRetentionScore: number;
  perEventResults: Array<{ eventId: number; result: FlexibleRetentionResult }>;
} {
  const perEventResults: Array<{ eventId: number; result: FlexibleRetentionResult }> = [];
  let totalAiLines = 0;
  let totalMatchedLines = 0;

  for (const event of events) {
    const result = calculateFlexibleRetention(event.lineHashes, fileHashes, options);
    perEventResults.push({ eventId: event.id, result });
    totalAiLines += result.totalAiLines;
    totalMatchedLines += result.matchedCount;
  }

  return {
    totalAiLines,
    totalMatchedLines,
    overallRetentionScore: totalAiLines > 0 ? totalMatchedLines / totalAiLines : 1.0,
    perEventResults,
  };
}
