const MANAGED_MAX_CHUNK_CHARS = 8192;
const MANAGED_MIN_CHUNK_CHARS = 50;
const MANAGED_OVERLAP_CHARS = MANAGED_MAX_CHUNK_CHARS * 0.1;
const MAX_UPLOAD_SIZE_BYTES = 1024 * 1024;

export type ManagedCodeChunk = {
  organizationId: string;
  projectId: string;
  filePath: string;
  codeChunk: string;
  /** Starting line number (1-based) */
  startLine: number;
  /** Ending line number (1-based, inclusive) */
  endLine: number;
  gitBranch: string;
  isBaseBranch: boolean;
};

export type ChunkerConfig = {
  maxChunkChars: number;
  minChunkChars: number;
  overlapChars: number;
};

export type ChunkMetadata = {
  filePath: string;
  organizationId: string;
  projectId: string;
  gitBranch: string;
  isBaseBranch: boolean;
};

export function getDefaultChunkerConfig(): ChunkerConfig {
  return {
    maxChunkChars: MANAGED_MAX_CHUNK_CHARS,
    minChunkChars: MANAGED_MIN_CHUNK_CHARS,
    overlapChars: MANAGED_OVERLAP_CHARS,
  };
}

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

  const calculateChunkChars = (lines: string[]): number => {
    return lines.reduce((sum, line) => sum + line.length + 1, 0);
  };

  const startNewChunkWithOverlap = (): void => {
    let overlapChars = 0;
    let linesToKeep = 0;

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

  const shouldFinalizeChunk = (lineLength: number): boolean => {
    return (
      currentChunkChars + lineLength > chunkerConfig.maxChunkChars &&
      currentChunk.length > 0 &&
      currentChunkChars >= chunkerConfig.minChunkChars
    );
  };

  try {
    while (true) {
      const { value, done: streamDone } = await reader.read();

      if (value) {
        // Use string length as approximation (fine to be inaccurate to avoid decoding cost)
        totalBytesRead += value.length;

        if (totalBytesRead > MAX_UPLOAD_SIZE_BYTES) {
          throw new Error(
            `File size exceeds maximum allowed size of 1MB. Current size: ${(totalBytesRead / 1024 / 1024).toFixed(2)}MB`
          );
        }

        buffer += value;
      }

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

    if (buffer.length > 0) {
      currentLineNumber++;
      const lineLength = buffer.length + 1;

      if (lineLength <= chunkerConfig.maxChunkChars) {
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
