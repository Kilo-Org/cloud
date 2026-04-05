/**
 * Streaming line-based file chunking for managed codebase indexing
 *
 * This module provides efficient streaming chunking that processes files
 * as they're uploaded via multipart form data. It chunks based on line
 * boundaries with configurable overlap, making it language-agnostic.
 */

// Constants
const MANAGED_MAX_CHUNK_CHARS = 8192;
const MANAGED_MIN_CHUNK_CHARS = 50;
const MANAGED_OVERLAP_CHARS = MANAGED_MAX_CHUNK_CHARS * 0.1;
const MAX_UPLOAD_SIZE_BYTES = 1024 * 1024; // 1 MB

/**
 * A code chunk with git metadata for managed indexing
 */
export type ManagedCodeChunk = {
  /** Organization ID */
  organizationId: string;
  /** Project ID */
  projectId: string;
  /** Relative file path from workspace root */
  filePath: string;
  /** The actual code content of this chunk */
  codeChunk: string;
  /** Starting line number (1-based) */
  startLine: number;
  /** Ending line number (1-based, inclusive) */
  endLine: number;
  /** Git branch this chunk belongs to */
  gitBranch: string;
  /** Whether this is from a base branch (main/develop) */
  isBaseBranch: boolean;
};

/**
 * Configuration for the line-based chunker
 */
export type ChunkerConfig = {
  /** Maximum characters per chunk (default: 1000) */
  maxChunkChars: number;
  /** Minimum characters per chunk (default: 50) */
  minChunkChars: number;
  /** Number of characters to overlap between chunks (default: 200) */
  overlapChars: number;
};

/**
 * Metadata required for chunking
 */
export type ChunkMetadata = {
  /** Relative file path from workspace root */
  filePath: string;
  /** Organization ID */
  organizationId: string;
  /** Project ID */
  projectId: string;
  /** Git branch name */
  gitBranch: string;
  /** Whether this is a base branch (main/develop) */
  isBaseBranch: boolean;
};

/**
 * Gets the default chunker configuration
 */
export function getDefaultChunkerConfig(): ChunkerConfig {
  return {
    maxChunkChars: MANAGED_MAX_CHUNK_CHARS,
    minChunkChars: MANAGED_MIN_CHUNK_CHARS,
    overlapChars: MANAGED_OVERLAP_CHARS,
  };
}

/**
 * Creates a single chunk with all required metadata
 */
function createChunk({
  lines,
  startLine,
  endLine,
  metadata,
}: {
  lines: string[];
  startLine: number;
  endLine: number;
  metadata: ChunkMetadata;
}): ManagedCodeChunk {
  const content = lines.join('\n');

  return {
    organizationId: metadata.organizationId,
    projectId: metadata.projectId,
    filePath: metadata.filePath,
    codeChunk: content,
    startLine,
    endLine,
    gitBranch: metadata.gitBranch,
    isBaseBranch: metadata.isBaseBranch,
  };
}

/**
 * Streams chunks from a readable stream of file content
 *
 * This async generator processes the stream line-by-line and yields chunks
 * as they're ready, allowing for efficient memory usage with large files.
 *
 * @param stream - A readable stream of the file content (text)
 * @param metadata - Metadata about the file being chunked
 * @param config - Optional chunker configuration
 * @yields ManagedCodeChunk objects as they're created
 *
 * @example
 * ```typescript
 * const stream = file.stream();
 * const textStream = stream.pipeThrough(new TextDecoderStream());
 *
 * for await (const chunk of streamChunks(textStream, metadata)) {
 *   // Process each chunk (e.g., generate embeddings, insert to DB)
 *   await processChunk(chunk);
 * }
 * ```
 */
export async function* streamChunks(
  stream: ReadableStream<string>,
  metadata: ChunkMetadata,
  config?: Partial<ChunkerConfig>
): AsyncGenerator<ManagedCodeChunk, void, unknown> {
  const chunkerConfig: ChunkerConfig = {
    maxChunkChars: config?.maxChunkChars ?? MANAGED_MAX_CHUNK_CHARS,
    minChunkChars: config?.minChunkChars ?? MANAGED_MIN_CHUNK_CHARS,
    overlapChars: config?.overlapChars ?? MANAGED_OVERLAP_CHARS,
  };

  const reader = stream.getReader();
  let buffer = '';
  let currentChunk: string[] = [];
  let currentChunkChars = 0;
  let startLine = 1;
  let currentLineNumber = 0;
  let hasYieldedChunk = false;
  let totalBytesRead = 0;

  // Helper to calculate chunk character count
  const calculateChunkChars = (lines: string[]): number => {
    return lines.reduce((sum, line) => sum + line.length + 1, 0);
  };

  // Helper to start a new chunk with overlap from the current one
  const startNewChunkWithOverlap = (): void => {
    // Calculate how many lines to keep for the overlap based on character count
    let overlapChars = 0;
    let linesToKeep = 0;

    // Count backwards from the end to find how many aproximate lines fit in the overlap
    for (let i = currentChunk.length - 1; i >= 0; i--) {
      const lineChars = currentChunk[i].length + 1; // +1 for newline
      if (overlapChars + lineChars <= chunkerConfig.overlapChars) {
        overlapChars += lineChars;
        linesToKeep++;
      } else {
        break;
      }
    }

    const overlapStart = Math.max(0, currentChunk.length - linesToKeep);
    currentChunk = currentChunk.slice(overlapStart);
    currentChunkChars = calculateChunkChars(currentChunk);
    startLine = currentLineNumber - currentChunk.length;
  };

  // Helper to check if we should finalize the current chunk and yield it
  const shouldFinalizeChunk = (lineLength: number): boolean => {
    return (
      currentChunkChars + lineLength > chunkerConfig.maxChunkChars &&
      currentChunk.length > 0 &&
      currentChunkChars >= chunkerConfig.minChunkChars
    );
  };

  try {
    // Read and process stream until fully consumed
    while (true) {
      const { value, done: streamDone } = await reader.read();

      if (value) {
        // Track total size and enforce 1MB limit
        // Use string length as approximation (fine to be inaccurate to avoid decoding cost)
        totalBytesRead += value.length;

        if (totalBytesRead > MAX_UPLOAD_SIZE_BYTES) {
          throw new Error(
            `File size exceeds maximum allowed size of 1MB. Current size: ${(totalBytesRead / 1024 / 1024).toFixed(2)}MB`
          );
        }

        buffer += value;
      }

      // Process complete lines from buffer
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        currentLineNumber++;
        const lineLength = line.length + 1; // +1 for newline character

        // Skip lines that are too large - they're unlikely to be valid source code
        // and will cause issues when embedding (exceeds token limits)
        if (lineLength > chunkerConfig.maxChunkChars) {
          continue;
        }

        // Finalize current chunk if adding this line would exceed max size
        if (shouldFinalizeChunk(lineLength)) {
          yield createChunk({
            lines: currentChunk,
            startLine,
            endLine: currentLineNumber - 1,
            metadata,
          });
          hasYieldedChunk = true;
          startNewChunkWithOverlap();
        }

        currentChunk.push(line);
        currentChunkChars += lineLength;
      }

      if (streamDone) {
        break;
      }
    }

    // Process any remaining content in buffer (last line without newline)
    if (buffer.length > 0) {
      currentLineNumber++;
      const lineLength = buffer.length + 1;

      // Skip if the last line is too large
      if (lineLength <= chunkerConfig.maxChunkChars) {
        // Finalize current chunk if adding the last line would exceed max size
        if (shouldFinalizeChunk(lineLength)) {
          yield createChunk({
            lines: currentChunk,
            startLine,
            endLine: currentLineNumber - 1,
            metadata,
          });
          hasYieldedChunk = true;
          startNewChunkWithOverlap();
        }

        currentChunk.push(buffer);
        currentChunkChars += lineLength;
      }
    }

    // Finalize last chunk
    // Always yield at least one chunk, even if it's below minimum size,
    // to ensure very small files (like index.ts re-exports) get indexed and appear in manifest
    if (currentChunk.length > 0) {
      if (!hasYieldedChunk || currentChunkChars >= chunkerConfig.minChunkChars) {
        yield createChunk({
          lines: currentChunk,
          startLine,
          endLine: currentLineNumber,
          metadata,
        });
      }
    }
  } finally {
    reader.releaseLock();
  }
}
