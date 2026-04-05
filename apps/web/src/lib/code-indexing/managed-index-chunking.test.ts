import { streamChunks, type ChunkMetadata } from '../managed-index-chunking';

/**
 * Helper to create a ReadableStream from a string
 */
function createStreamFromString(content: string): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(content);
      controller.close();
    },
  });
}

/**
 * Helper to collect all chunks from the async generator
 */
async function collectChunks(
  stream: ReadableStream<string>,
  metadata: ChunkMetadata,
  config?: { maxChunkChars?: number; minChunkChars?: number; overlapLines?: number }
) {
  const chunks = [];
  for await (const chunk of streamChunks(stream, metadata, config)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('streamChunks', () => {
  const baseMetadata: ChunkMetadata = {
    filePath: 'test.ts',
    organizationId: 'org-123',
    projectId: 'proj-456',
    gitBranch: 'main',
    isBaseBranch: true,
  };

  describe('basic chunking', () => {
    it('should chunk a simple file with multiple lines', async () => {
      const content = 'line1\nline2\nline3\nline4\nline5';
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].organizationId).toBe('org-123');
      expect(chunks[0].projectId).toBe('proj-456');
      expect(chunks[0].gitBranch).toBe('main');
      expect(chunks[0].isBaseBranch).toBe(true);
    });

    it('should handle a single line file', async () => {
      const content = 'single line of code';
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0].codeChunk).toBe('single line of code');
      expect(chunks[0].startLine).toBe(1);
      expect(chunks[0].endLine).toBe(1);
    });

    it('should handle empty file', async () => {
      const content = '';
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      expect(chunks).toHaveLength(0);
    });
  });

  describe('extremely long lines', () => {
    it('should skip a single line that exceeds maxChunkChars', async () => {
      const longLine = 'x'.repeat(150); // Exceeds maxChunkChars of 100
      const content = `line1\n${longLine}\nline3`;
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      // Should have chunks but the long line should be skipped
      expect(chunks.length).toBeGreaterThan(0);

      // Verify the long line is not in any chunk
      const allContent = chunks.map(c => c.codeChunk).join('\n');
      expect(allContent).not.toContain(longLine);

      // Verify line1 and line3 are present
      expect(allContent).toContain('line1');
      expect(allContent).toContain('line3');
    });

    it('should skip a single line huge line file', async () => {
      const longLine = 'x'.repeat(1500); // Exceeds maxChunkChars of 100
      const content = longLine;
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      // Should have chunks but the long line should be skipped
      expect(chunks.length).toBe(0);
    });

    it('should skip multiple extremely long lines', async () => {
      const longLine1 = 'a'.repeat(150);
      const longLine2 = 'b'.repeat(200);
      const content = `line1\n${longLine1}\nline2\n${longLine2}\nline3`;
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      const allContent = chunks.map(c => c.codeChunk).join('\n');

      // Long lines should be skipped
      expect(allContent).not.toContain(longLine1);
      expect(allContent).not.toContain(longLine2);

      // Normal lines should be present
      expect(allContent).toContain('line1');
      expect(allContent).toContain('line2');
      expect(allContent).toContain('line3');
    });

    it('should skip extremely long line at the beginning', async () => {
      const longLine = 'x'.repeat(150);
      const content = `${longLine}\nline2\nline3`;
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      const allContent = chunks.map(c => c.codeChunk).join('\n');
      expect(allContent).not.toContain(longLine);
      expect(allContent).toContain('line2');
      expect(allContent).toContain('line3');
    });

    it('should skip extremely long line at the end', async () => {
      const longLine = 'x'.repeat(150);
      const content = `line1\nline2\n${longLine}`;
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      const allContent = chunks.map(c => c.codeChunk).join('\n');
      expect(allContent).not.toContain(longLine);
      expect(allContent).toContain('line1');
      expect(allContent).toContain('line2');
    });

    it('should handle file with only extremely long lines', async () => {
      const longLine1 = 'a'.repeat(150);
      const longLine2 = 'b'.repeat(200);
      const content = `${longLine1}\n${longLine2}`;
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      // Should have no chunks since all lines are too long
      expect(chunks).toHaveLength(0);
    });

    it('should skip extremely long line without trailing newline', async () => {
      const longLine = 'x'.repeat(150);
      const content = `line1\nline2\n${longLine}`; // No trailing newline
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      const allContent = chunks.map(c => c.codeChunk).join('\n');
      expect(allContent).not.toContain(longLine);
      expect(allContent).toContain('line1');
      expect(allContent).toContain('line2');
    });
  });

  describe('overlap behavior', () => {
    it('should create overlapping chunks', async () => {
      // Create content that will span multiple chunks
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
      const content = lines.join('\n');
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 50, // Small enough to force multiple chunks
        minChunkChars: 10,
        overlapLines: 3,
      });

      expect(chunks.length).toBeGreaterThan(1);

      // Check that consecutive chunks have overlap
      for (let i = 0; i < chunks.length - 1; i++) {
        const currentChunkLines = chunks[i].codeChunk.split('\n');
        const nextChunkLines = chunks[i + 1].codeChunk.split('\n');

        // The last few lines of current chunk should appear in the next chunk
        const overlapFound = currentChunkLines
          .slice(-3)
          .some(line => nextChunkLines.includes(line));
        expect(overlapFound).toBe(true);
      }
    });

    it('should maintain correct line numbers with overlap', async () => {
      const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`);
      const content = lines.join('\n');
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 50,
        minChunkChars: 10,
        overlapLines: 2,
      });

      // Verify line numbers are sequential and make sense
      expect(chunks[0].startLine).toBe(1);

      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].endLine).toBeGreaterThanOrEqual(chunks[i].startLine);

        if (i > 0) {
          // Next chunk should start at or before the end of previous chunk (due to overlap)
          expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine + 1);
        }
      }
    });

    it('should not include skipped long lines in overlap', async () => {
      const longLine = 'x'.repeat(150);
      const lines = ['line1', 'line2', longLine, 'line3', 'line4', 'line5'];
      const content = lines.join('\n');
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      // Verify the long line doesn't appear in any chunk
      for (const chunk of chunks) {
        expect(chunk.codeChunk).not.toContain(longLine);
      }

      // Verify all normal lines are accounted for
      const allContent = chunks.map(c => c.codeChunk).join('\n');
      expect(allContent).toContain('line1');
      expect(allContent).toContain('line2');
      expect(allContent).toContain('line3');
      expect(allContent).toContain('line4');
      expect(allContent).toContain('line5');
    });
  });

  describe('line accounting', () => {
    it('should account for all normal lines exactly once (excluding overlap)', async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
      const content = lines.join('\n');
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 50,
        minChunkChars: 10,
        overlapLines: 2,
      });

      // Count unique line numbers across all chunks
      const lineNumbers = new Set<number>();
      for (const chunk of chunks) {
        for (let i = chunk.startLine; i <= chunk.endLine; i++) {
          lineNumbers.add(i);
        }
      }

      // All 10 lines should be represented
      expect(lineNumbers.size).toBe(10);
      expect(Math.min(...lineNumbers)).toBe(1);
      expect(Math.max(...lineNumbers)).toBe(10);
    });

    it('should account for all lines when long lines are interspersed', async () => {
      const longLine = 'x'.repeat(150);
      const content = `line1\nline2\n${longLine}\nline4\nline5\n${longLine}\nline7`;
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      const allContent = chunks.map(c => c.codeChunk).join('\n');

      // All normal lines should be present
      expect(allContent).toContain('line1');
      expect(allContent).toContain('line2');
      expect(allContent).toContain('line4');
      expect(allContent).toContain('line5');
      expect(allContent).toContain('line7');

      // Long lines should not be present
      expect(allContent).not.toContain(longLine);
    });
  });

  describe('edge cases', () => {
    it('should handle line exactly at maxChunkChars boundary', async () => {
      // Line with exactly 99 chars (100 with newline)
      const exactLine = 'x'.repeat(99);
      const content = `line1\n${exactLine}\nline3`;
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      const allContent = chunks.map(c => c.codeChunk).join('\n');
      // Should include the line that's exactly at the boundary
      expect(allContent).toContain(exactLine);
    });

    it('should handle line one char over maxChunkChars', async () => {
      // Line with 100 chars (101 with newline) - should be skipped
      const overLine = 'x'.repeat(100);
      const content = `line1\n${overLine}\nline3`;
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      const allContent = chunks.map(c => c.codeChunk).join('\n');
      // Should skip the line that's one char over
      expect(allContent).not.toContain(overLine);
    });

    it('should handle mixed line lengths with some exceeding limit', async () => {
      const shortLine = 'short';
      const mediumLine = 'x'.repeat(50);
      const longLine = 'y'.repeat(150);
      const content = `${shortLine}\n${mediumLine}\n${longLine}\n${shortLine}\n${mediumLine}`;
      const stream = createStreamFromString(content);

      const chunks = await collectChunks(stream, baseMetadata, {
        maxChunkChars: 100,
        minChunkChars: 10,
        overlapLines: 2,
      });

      const allContent = chunks.map(c => c.codeChunk).join('\n');

      // Short and medium lines should be present
      expect(allContent).toContain(shortLine);
      expect(allContent).toContain(mediumLine);

      // Long line should be skipped
      expect(allContent).not.toContain(longLine);
    });
  });
});
