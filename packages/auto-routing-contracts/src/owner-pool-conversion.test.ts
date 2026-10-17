import { describe, expect, it } from 'vitest';
import { CustomRouterDefinitionSchema } from './custom-router';
import {
  OwnerPoolConversionRequestSchema,
  OwnerPoolConversionScanResponseSchema,
  OwnerPoolConversionSchema,
  convertedOwnerPoolRouter,
} from './owner-pool-conversion';

describe('convertedOwnerPoolRouter', () => {
  it('maps a pool to the efficient router with the first model as default', () => {
    const router = convertedOwnerPoolRouter({
      owner: { type: 'user', id: 'user-1' },
      mode: 'best_accuracy',
      models: ['b/second-listed-first', 'a/other'],
    });

    expect(router).toEqual({
      slug: 'efficient',
      name: 'Efficient',
      baseRouter: 'efficient',
      mode: 'best_accuracy',
      entries: [
        { kind: 'gateway', model: 'b/second-listed-first' },
        { kind: 'gateway', model: 'a/other' },
      ],
      defaultEntryKey: 'gateway:b/second-listed-first',
      modelId: 'kilo-auto/custom/efficient',
    });
  });

  it('names the organization model ID for an organization pool', () => {
    const router = convertedOwnerPoolRouter({
      owner: { type: 'org', id: '7b0e5a34-1d7c-4f8e-9a51-1f0c2c3d4e5f' },
      mode: 'cost_per_accuracy',
      models: ['a/model'],
    });
    expect(router.modelId).toBe('kilo-auto/custom/org/efficient');
  });

  it('produces a valid custom router definition', () => {
    const router = convertedOwnerPoolRouter({
      owner: { type: 'user', id: 'user-1' },
      mode: 'cost_per_accuracy',
      models: ['a/model', 'b/model'],
    });
    const parsed = CustomRouterDefinitionSchema.safeParse({
      id: '7b0e5a34-1d7c-4f8e-9a51-1f0c2c3d4e5f',
      ownerType: 'user',
      ownerId: 'user-1',
      ...router,
    });
    expect(parsed.success).toBe(true);
  });
});

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
  it('reads a summary from a worker deployed before the newer fields', () => {
    const parsed = OwnerPoolConversionScanResponseSchema.parse({
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
    });

    expect(parsed).toMatchObject({ notPosted: [], abortReason: null, consecutiveFailed: 0 });
  });
});
