import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModels: jest.fn(async () => new Set<string>()),
}));

jest.mock('@/lib/kiloclaw/setup-promo', () => ({
  userIsWithinFirstKiloClawInstanceWindow: jest.fn(async () => false),
}));

import { resolveAutoModel } from './resolution';
import { BALANCED_QWEN_MODEL, KILO_AUTO_EFFICIENT_MODEL } from '@/lib/ai-gateway/auto-model';
import type { AutoRoutingDecision } from '@kilocode/auto-routing-contracts';

const baseParams = {
  model: KILO_AUTO_EFFICIENT_MODEL.id,
  modeHeader: null,
  featureHeader: null,
  sessionId: null,
  clientIp: null,
};

const nullUserPromise = Promise.resolve(null);
const zeroBalancePromise = Promise.resolve(0);

const sampleDecision: AutoRoutingDecision = {
  model: 'anthropic/claude-haiku-4',
  taskType: 'implementation',
  subtaskType: 'feature_development',
  source: 'benchmark',
  tableVersion: 'v1',
  sticky: false,
};

describe('resolveAutoModel — kilo-auto/efficient branch', () => {
  it('resolves to decision.model when the thunk returns a decision', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => sampleDecision,
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: { model: 'anthropic/claude-haiku-4' } });
  });

  it('applies the decision reasoningEffort as a reasoning config', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({ ...sampleDecision, reasoningEffort: 'minimal' }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'ok',
      resolved: {
        model: 'anthropic/claude-haiku-4',
        reasoning: { enabled: true, effort: 'minimal' },
      },
    });
  });

  it('omits reasoning when the decision reasoningEffort is null', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({ ...sampleDecision, reasoningEffort: null }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: { model: 'anthropic/claude-haiku-4' } });
  });

  it('falls back to BALANCED_QWEN_MODEL when no thunk is provided and apiKind=responses', async () => {
    const result = await resolveAutoModel(
      { ...baseParams, apiKind: 'responses' },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: BALANCED_QWEN_MODEL });
  });

  it('falls back to BALANCED_QWEN_MODEL when no thunk is provided and apiKind=messages', async () => {
    const result = await resolveAutoModel(
      { ...baseParams, apiKind: 'messages' },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: BALANCED_QWEN_MODEL });
  });

  it('falls back to BALANCED_QWEN_MODEL when no thunk is provided and apiKind=chat_completions', async () => {
    const result = await resolveAutoModel(
      { ...baseParams, apiKind: 'chat_completions' },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: BALANCED_QWEN_MODEL });
  });

  it('falls back to BALANCED_QWEN_MODEL when thunk returns null and apiKind=chat_completions', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => null,
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: BALANCED_QWEN_MODEL });
  });

  it('does not call the thunk more than once', async () => {
    const thunk = jest.fn(async () => sampleDecision);

    await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: thunk,
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(thunk).toHaveBeenCalledTimes(1);
  });
});
