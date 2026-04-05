import { calculateFlexibleRetention, calculateAggregatedRetention } from './flexible-retention';

describe('calculateFlexibleRetention', () => {
  // Use simple string hashes for testing (not actual SHA-1)
  const hashA = 'hash_a_unique_line';
  const hashB = 'hash_b_unique_line';
  const hashC = 'hash_c_unique_line';
  const hashD = 'hash_d_unique_line';
  const hashX = 'hash_x_inserted';
  const hashY = 'hash_y_inserted';

  describe('basic matching', () => {
    it('returns 100% retention when all AI lines are present in order', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashA, hashB, hashC];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(3);
      expect(result.totalAiLines).toBe(3);
      expect(result.retentionScore).toBe(1.0);
    });

    it('returns 0% retention when no AI lines are present', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashX, hashY];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(0);
      expect(result.totalAiLines).toBe(3);
      expect(result.retentionScore).toBe(0);
    });

    it('handles empty AI hashes', () => {
      const aiHashes: string[] = [];
      const fileHashes = [hashA, hashB];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(0);
      expect(result.totalAiLines).toBe(0);
      expect(result.retentionScore).toBe(1.0);
    });

    it('handles empty file hashes', () => {
      const aiHashes = [hashA, hashB];
      const fileHashes: string[] = [];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(0);
      expect(result.totalAiLines).toBe(2);
      expect(result.retentionScore).toBe(0);
    });
  });

  describe('insertion handling', () => {
    it('handles insertions at the beginning', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashX, hashY, hashA, hashB, hashC];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(3);
      expect(result.retentionScore).toBe(1.0);
    });

    it('handles insertions in the middle', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashA, hashX, hashY, hashB, hashC];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(3);
      expect(result.retentionScore).toBe(1.0);
    });

    it('handles insertions at the end', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashA, hashB, hashC, hashX, hashY];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(3);
      expect(result.retentionScore).toBe(1.0);
    });

    it('handles multiple insertions throughout', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashX, hashA, hashY, hashB, hashX, hashY, hashC, hashX];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(3);
      expect(result.retentionScore).toBe(1.0);
    });
  });

  describe('deletion handling', () => {
    it('handles deletion of first line', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashB, hashC];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(2);
      expect(result.totalAiLines).toBe(3);
      expect(result.retentionScore).toBeCloseTo(2 / 3);
    });

    it('handles deletion of middle line', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashA, hashC];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(2);
      expect(result.retentionScore).toBeCloseTo(2 / 3);
    });

    it('handles deletion of last line', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashA, hashB];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(2);
      expect(result.retentionScore).toBeCloseTo(2 / 3);
    });

    it('handles multiple deletions', () => {
      const aiHashes = [hashA, hashB, hashC, hashD];
      const fileHashes = [hashA, hashD];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(2);
      expect(result.retentionScore).toBe(0.5);
    });
  });

  describe('combined insertions and deletions', () => {
    it('handles insertions and deletions together', () => {
      const aiHashes = [hashA, hashB, hashC];
      // User deleted B, inserted X and Y
      const fileHashes = [hashA, hashX, hashY, hashC];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(2);
      expect(result.retentionScore).toBeCloseTo(2 / 3);
    });

    it('handles complex refactoring scenario', () => {
      const aiHashes = [hashA, hashB, hashC, hashD];
      // User wrapped in try/catch (inserted X at start), deleted C, added Y at end
      const fileHashes = [hashX, hashA, hashB, hashD, hashY];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedCount).toBe(3);
      expect(result.retentionScore).toBe(0.75);
    });
  });

  describe('lookahead limit', () => {
    it('respects lookahead limit', () => {
      const aiHashes = [hashA, hashB];
      // Insert many lines between A and B
      const manyInsertions: string[] = Array(100).fill(hashX) as string[];
      const fileHashes = [hashA, ...manyInsertions, hashB];

      // With small lookahead, B won't be found
      const resultSmall = calculateFlexibleRetention(aiHashes, fileHashes, {
        lookaheadLimit: 10,
        stopHashes: new Set(),
      });
      expect(resultSmall.matchedCount).toBe(1);

      // With large lookahead, B will be found
      const resultLarge = calculateFlexibleRetention(aiHashes, fileHashes, {
        lookaheadLimit: 150,
        stopHashes: new Set(),
      });
      expect(resultLarge.matchedCount).toBe(2);
    });
  });

  describe('stop hashes (low-entropy lines)', () => {
    const stopHash1 = 'stop_hash_brace';
    const stopHash2 = 'stop_hash_return';

    it('ignores stop hashes in AI code for matching', () => {
      const aiHashes = [hashA, stopHash1, hashB, stopHash2, hashC];
      const fileHashes = [hashA, hashB, hashC];
      const stopHashes = new Set([stopHash1, stopHash2]);

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes });

      // All significant lines matched, stop hashes counted proportionally
      expect(result.matchedCount).toBe(5);
      expect(result.retentionScore).toBe(1.0);
    });

    it('ignores stop hashes in file during matching', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashA, stopHash1, stopHash2, hashB, hashC];
      const stopHashes = new Set([stopHash1, stopHash2]);

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes });

      expect(result.matchedCount).toBe(3);
      expect(result.retentionScore).toBe(1.0);
    });

    it('handles all AI lines being stop hashes', () => {
      const aiHashes = [stopHash1, stopHash2];
      const fileHashes = [hashA, hashB];
      const stopHashes = new Set([stopHash1, stopHash2]);

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes });

      // All low-entropy, considered 100% retained
      expect(result.retentionScore).toBe(1.0);
    });

    it('uses default LOW_ENTROPY_HASHES when not specified', () => {
      // Empty line hash
      const emptyLineHash = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
      const aiHashes = [hashA, emptyLineHash, hashB];
      const fileHashes = [hashA, hashB];

      const result = calculateFlexibleRetention(aiHashes, fileHashes);

      // Empty line is in LOW_ENTROPY_HASHES, so it's ignored for matching
      expect(result.matchedCount).toBe(3);
      expect(result.retentionScore).toBe(1.0);
    });
  });

  describe('matchedFileIndices', () => {
    it('returns correct file indices for matches', () => {
      const aiHashes = [hashA, hashB, hashC];
      const fileHashes = [hashX, hashA, hashY, hashB, hashC];

      const result = calculateFlexibleRetention(aiHashes, fileHashes, { stopHashes: new Set() });

      expect(result.matchedFileIndices).toEqual([1, 3, 4]);
    });
  });
});

describe('calculateAggregatedRetention', () => {
  const hashA = 'hash_a';
  const hashB = 'hash_b';
  const hashC = 'hash_c';
  const hashD = 'hash_d';

  it('aggregates retention across multiple events', () => {
    const events = [
      { id: 1, lineHashes: [hashA, hashB] },
      { id: 2, lineHashes: [hashC, hashD] },
    ];
    const fileHashes = [hashA, hashB, hashC]; // D is missing

    const result = calculateAggregatedRetention(events, fileHashes, { stopHashes: new Set() });

    expect(result.totalAiLines).toBe(4);
    expect(result.totalMatchedLines).toBe(3);
    expect(result.overallRetentionScore).toBe(0.75);
    expect(result.perEventResults).toHaveLength(2);
    expect(result.perEventResults[0].eventId).toBe(1);
    expect(result.perEventResults[0].result.retentionScore).toBe(1.0);
    expect(result.perEventResults[1].eventId).toBe(2);
    expect(result.perEventResults[1].result.retentionScore).toBe(0.5);
  });

  it('handles empty events array', () => {
    const events: { id: number; lineHashes: string[] }[] = [];
    const fileHashes = [hashA, hashB];

    const result = calculateAggregatedRetention(events, fileHashes, { stopHashes: new Set() });

    expect(result.totalAiLines).toBe(0);
    expect(result.totalMatchedLines).toBe(0);
    expect(result.overallRetentionScore).toBe(1.0);
    expect(result.perEventResults).toHaveLength(0);
  });
});
