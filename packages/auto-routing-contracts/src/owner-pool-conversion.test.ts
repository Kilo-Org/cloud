import { describe, expect, it } from 'vitest';
import {
  OwnerPoolConversionRequestSchema,
  OwnerPoolConversionScanResponseSchema,
  OwnerPoolConversionSchema,
} from './owner-pool-conversion';

describe('OwnerPoolConversionSchema', () => {
  it('rejects an empty pool and duplicate models', () => {
    const owner = { type: 'user', id: 'user-1' };
    expect(
      OwnerPoolConversionSchema.safeParse({ owner, mode: 'best_accuracy', models: [] }).success
    ).toBe(false);
    expect(
      OwnerPoolConversionSchema.safeParse({ owner, mode: 'best_accuracy', models: ['a/b', 'a/b'] })
        .success
    ).toBe(false);
  });

  it('rejects an empty conversion batch', () => {
    expect(OwnerPoolConversionRequestSchema.safeParse({ conversions: [] }).success).toBe(false);
  });
});

describe('OwnerPoolConversionScanResponseSchema', () => {
  const olderSummary = {
    scanned: 1,
    nextCursor: null,
    matchedObjectIds: [],
    alreadyConverted: 0,
    conversions: 0,
    droppedModeOnly: 0,
    readFailed: [],
    invalidPool: [],
    invalidMode: [],
    needsAttention: [],
    outcomes: {
      created: 0,
      exists: 0,
      slug_taken: 0,
      router_cap_reached: 0,
      owner_not_found: 0,
      failed: 0,
    },
    noticesSent: 0,
    noticesFailed: 0,
    aborted: false,
  };

  it('reads a summary from a worker deployed before the newer fields', () => {
    expect(OwnerPoolConversionScanResponseSchema.parse(olderSummary)).toMatchObject({
      notPosted: [],
      abortReason: null,
      consecutiveFailed: 0,
    });
  });

  it('reads an abort reason this script does not know as unknown rather than failing the run', () => {
    expect(
      OwnerPoolConversionScanResponseSchema.parse({
        ...olderSummary,
        aborted: true,
        abortReason: 'page_timeout',
      }).abortReason
    ).toBeNull();
  });
});
