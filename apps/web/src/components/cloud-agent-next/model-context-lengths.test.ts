import type { ContextUsage } from '@/lib/cloud-agent-sdk/context-usage';
import { buildContextLengthByModelId, resolveContextWindow } from './model-context-lengths';

const contextUsage = {
  contextTokens: 32_418,
  providerID: 'kilo',
  modelID: 'anthropic/claude-sonnet-4',
} satisfies ContextUsage;

describe('buildContextLengthByModelId', () => {
  it('maps exact catalog model ids without aliases', () => {
    const lengths = buildContextLengthByModelId([
      { id: 'anthropic/claude-sonnet-4', context_length: 200_000 },
      { id: 'kilo-auto/free', context_length: 114_688 },
      { id: 'fake-deterministic', context_length: 200_000 },
      { id: 'kilo/preview-allowed-by-policy', context_length: 80_000 },
    ]);

    expect(lengths).toEqual(
      new Map([
        ['anthropic/claude-sonnet-4', 200_000],
        ['kilo-auto/free', 114_688],
        ['fake-deterministic', 200_000],
        ['kilo/preview-allowed-by-policy', 80_000],
      ])
    );
    expect(lengths.has('preview-allowed-by-policy')).toBe(false);
  });

  it('omits invalid context lengths', () => {
    expect(
      buildContextLengthByModelId([
        { id: 'zero', context_length: 0 },
        { id: 'negative', context_length: -1 },
        { id: 'missing', context_length: undefined },
        { id: 'nan', context_length: Number.NaN },
        { id: 'infinity', context_length: Number.POSITIVE_INFINITY },
      ])
    ).toEqual(new Map());
  });

  it('retains agreeing duplicate exact ids', () => {
    expect(
      buildContextLengthByModelId([
        { id: 'anthropic/claude-sonnet-4', context_length: 200_000 },
        { id: 'anthropic/claude-sonnet-4', context_length: 200_000 },
      ])
    ).toEqual(new Map([['anthropic/claude-sonnet-4', 200_000]]));
  });

  it('permanently omits a conflicting duplicate exact id', () => {
    expect(
      buildContextLengthByModelId([
        { id: 'anthropic/claude-sonnet-4', context_length: 200_000 },
        { id: 'anthropic/claude-sonnet-4', context_length: 80_000 },
        { id: 'anthropic/claude-sonnet-4', context_length: 200_000 },
      ])
    ).toEqual(new Map());
  });
});

describe('resolveContextWindow', () => {
  it('resolves a known kilo response by exact emitted model id', () => {
    expect(resolveContextWindow(contextUsage, new Map([[contextUsage.modelID, 200_000]]))).toBe(
      200_000
    );
  });

  it('returns undefined for missing usage or a non-kilo provider', () => {
    expect(
      resolveContextWindow(undefined, new Map([[contextUsage.modelID, 200_000]]))
    ).toBeUndefined();
    expect(
      resolveContextWindow(
        { ...contextUsage, providerID: 'anthropic' },
        new Map([[contextUsage.modelID, 200_000]])
      )
    ).toBeUndefined();
  });

  it('returns undefined for missing or non-positive capacities', () => {
    expect(resolveContextWindow(contextUsage, new Map())).toBeUndefined();
    expect(
      resolveContextWindow(contextUsage, new Map([[contextUsage.modelID, 0]]))
    ).toBeUndefined();
    expect(
      resolveContextWindow(contextUsage, new Map([[contextUsage.modelID, -1]]))
    ).toBeUndefined();
  });

  it('returns undefined rather than guessing a stripped experiment id alias', () => {
    expect(
      resolveContextWindow(
        { ...contextUsage, modelID: 'preview-allowed-by-policy' },
        new Map([['kilo/preview-allowed-by-policy', 80_000]])
      )
    ).toBeUndefined();
  });
});
