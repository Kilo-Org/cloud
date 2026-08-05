import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModelsFromRedis: jest.fn(async () => new Set<string>()),
}));

import { resolveAutoModel } from './resolution';
import {
  BALANCED_QWEN_MODEL,
  FRONTIER_MODE_TO_MODEL,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FREE_MODEL,
  ORG_AUTO_MODEL,
} from '@/lib/ai-gateway/auto-model';
import type { AutoRoutingDecision } from '@kilocode/auto-routing-contracts';

const baseParams = {
  model: KILO_AUTO_EFFICIENT_MODEL.id,
  modeHeader: null,
  featureHeader: null,
  sessionId: null,
  clientIp: null,
  isAutoFreeCandidateAllowed: null,
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
  it('resolves kilo-auto/balanced as an alias of kilo-auto/efficient', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: KILO_AUTO_BALANCED_MODEL.id,
        apiKind: 'chat_completions',
        efficientDecision: async () => sampleDecision,
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: { model: sampleDecision.model } });
  });

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

  it('falls back to BALANCED_QWEN_MODEL when the worker returns a virtual auto model', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({
          ...sampleDecision,
          model: KILO_AUTO_EFFICIENT_MODEL.id,
        }),
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

  it('applies complete catalog settings for variant xhigh (distinct from max)', async () => {
    // Claude catalog: xhigh → effort xhigh + verbosity xhigh; max → effort xhigh + verbosity max
    const claudeModel = 'anthropic/claude-sonnet-5';
    const xhighResult = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({
          ...sampleDecision,
          model: claudeModel,
          variant: 'xhigh',
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );
    const maxResult = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({
          ...sampleDecision,
          model: claudeModel,
          variant: 'max',
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(xhighResult).toEqual({
      kind: 'ok',
      resolved: {
        model: claudeModel,
        reasoning: { enabled: true, effort: 'xhigh' },
        verbosity: 'xhigh',
      },
    });
    expect(maxResult).toEqual({
      kind: 'ok',
      resolved: {
        model: claudeModel,
        reasoning: { enabled: true, effort: 'xhigh' },
        verbosity: 'max',
      },
    });
    expect(xhighResult).not.toEqual(maxResult);
  });

  it('applies Claude max variant with both reasoning and verbosity', async () => {
    const claudeModel = 'anthropic/claude-haiku-4.5';
    const result = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({
          ...sampleDecision,
          model: claudeModel,
          variant: 'max',
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'ok',
      resolved: {
        model: claudeModel,
        reasoning: { enabled: true, effort: 'xhigh' },
        verbosity: 'max',
      },
    });
  });

  it('falls back to BALANCED_QWEN_MODEL when variant is absent from the model catalog', async () => {
    // Claude has no "thinking" key — only none/low/medium/high/xhigh/max
    const result = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({
          ...sampleDecision,
          model: 'anthropic/claude-sonnet-5',
          variant: 'thinking',
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: BALANCED_QWEN_MODEL });
  });

  it('falls back to BALANCED_QWEN_MODEL when the model exposes no variants but decision has a variant', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({
          ...sampleDecision,
          model: 'some-provider/unknown-model-without-variants',
          variant: 'high',
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: BALANCED_QWEN_MODEL });
  });

  it('applies exact thinking and instant variant settings', async () => {
    // Mistral uses REASONING_VARIANTS_BINARY: instant + thinking
    const binaryModel = 'mistralai/mistral-medium-3-5';
    const thinkingResult = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({
          ...sampleDecision,
          model: binaryModel,
          variant: 'thinking',
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );
    const instantResult = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({
          ...sampleDecision,
          model: binaryModel,
          variant: 'instant',
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(thinkingResult).toEqual({
      kind: 'ok',
      resolved: {
        model: binaryModel,
        reasoning: { enabled: true, effort: 'high' },
      },
    });
    expect(instantResult).toEqual({
      kind: 'ok',
      resolved: {
        model: binaryModel,
        reasoning: { enabled: false, effort: 'none' },
      },
    });
  });

  it('preserves legacy effort-only behavior when variant is absent', async () => {
    const withEffort = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({ ...sampleDecision, reasoningEffort: 'high' }),
      },
      nullUserPromise,
      zeroBalancePromise
    );
    const withoutEffort = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => sampleDecision,
      },
      nullUserPromise,
      zeroBalancePromise
    );
    const nullEffort = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({ ...sampleDecision, reasoningEffort: null }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(withEffort).toEqual({
      kind: 'ok',
      resolved: {
        model: 'anthropic/claude-haiku-4',
        reasoning: { enabled: true, effort: 'high' },
      },
    });
    expect(withoutEffort).toEqual({
      kind: 'ok',
      resolved: { model: 'anthropic/claude-haiku-4' },
    });
    expect(nullEffort).toEqual({
      kind: 'ok',
      resolved: { model: 'anthropic/claude-haiku-4' },
    });
  });

  it('still falls back when the decision model is a virtual auto model even with a variant', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => ({
          ...sampleDecision,
          model: KILO_AUTO_EFFICIENT_MODEL.id,
          variant: 'high',
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: BALANCED_QWEN_MODEL });
  });
});

describe('resolveAutoModel — kilo-auto/free branch', () => {
  it('excludes candidates denied by the effective organization policy', async () => {
    const isAutoFreeCandidateAllowed = jest.fn(
      async (modelId: string) => modelId === 'stepfun/step-3.7-flash:free'
    );

    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: KILO_AUTO_FREE_MODEL.id,
        apiKind: 'chat_completions',
        isAutoFreeCandidateAllowed,
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'ok',
      resolved: { model: 'stepfun/step-3.7-flash:free' },
    });
    expect(isAutoFreeCandidateAllowed).toHaveBeenCalledWith('stepfun/step-3.7-flash:free');
  });

  it('reports no free models when organization policy denies every candidate', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: KILO_AUTO_FREE_MODEL.id,
        apiKind: 'chat_completions',
        isAutoFreeCandidateAllowed: async () => false,
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'no_free_models_available' });
  });
});

describe('resolveAutoModel — Organization Auto branch', () => {
  it('uses exact built-in alias routes before canonical fallback routes', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'build',
        apiKind: 'chat_completions',
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            default_model: ORG_AUTO_MODEL.id,
            org_auto_model: {
              routes: {
                code: 'kilo-auto/frontier',
                build: 'kilo-auto/small',
              },
              fallback_model: 'kilo-auto/balanced',
            },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toMatchObject({
      kind: 'ok',
      routingTarget: 'kilo-auto/small',
    });
  });

  it('uses exact plan routes before architect fallback routes', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'plan',
        apiKind: 'chat_completions',
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            default_model: ORG_AUTO_MODEL.id,
            org_auto_model: {
              routes: {
                architect: 'kilo-auto/balanced',
                plan: 'kilo-auto/frontier',
              },
              fallback_model: 'kilo-auto/balanced',
            },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'ok',
      resolved: FRONTIER_MODE_TO_MODEL.plan,
      routingTarget: 'kilo-auto/frontier',
    });
  });

  it('falls build back to the canonical code route', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'build',
        apiKind: 'chat_completions',
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            default_model: ORG_AUTO_MODEL.id,
            org_auto_model: {
              routes: { code: 'kilo-auto/frontier' },
              fallback_model: 'kilo-auto/balanced',
            },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toMatchObject({
      kind: 'ok',
      routingTarget: 'kilo-auto/frontier',
    });
  });

  it('does not fall canonical code back to a build route', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'code',
        apiKind: 'chat_completions',
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            default_model: ORG_AUTO_MODEL.id,
            org_auto_model: {
              routes: { build: 'kilo-auto/frontier' },
              fallback_model: 'kilo-auto/balanced',
            },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toMatchObject({
      kind: 'ok',
      routingTarget: 'kilo-auto/balanced',
    });
  });

  it('falls plan back to architect without falling architect back to plan', async () => {
    const settings = {
      default_model: ORG_AUTO_MODEL.id,
      org_auto_model: {
        routes: { architect: 'kilo-auto/frontier', plan: 'kilo-auto/small' },
        fallback_model: 'kilo-auto/balanced',
      },
    };
    const planResult = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'plan',
        apiKind: 'chat_completions',
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            ...settings,
            org_auto_model: {
              ...settings.org_auto_model,
              routes: { architect: 'kilo-auto/frontier' },
            },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );
    const architectResult = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'architect',
        apiKind: 'chat_completions',
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            ...settings,
            org_auto_model: { ...settings.org_auto_model, routes: { plan: 'kilo-auto/small' } },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(planResult).toMatchObject({ kind: 'ok', routingTarget: 'kilo-auto/frontier' });
    expect(architectResult).toMatchObject({ kind: 'ok', routingTarget: 'kilo-auto/balanced' });
  });

  it('uses the configured fallback when no mode route exists', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'custom-mode',
        apiKind: 'chat_completions',
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            default_model: ORG_AUTO_MODEL.id,
            org_auto_model: {
              routes: {},
              fallback_model: 'kilo-auto/balanced',
            },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'ok',
      resolved: BALANCED_QWEN_MODEL,
      routingTarget: 'kilo-auto/balanced',
    });
  });

  it('rejects Organization Auto without an organization context', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        apiKind: 'chat_completions',
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'organization_auto_configuration_error',
      message: 'Organization Auto is not available for this account.',
    });
  });

  it('rejects direct Organization Auto requests after it is disabled', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        apiKind: 'chat_completions',
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            default_model: 'kilo-auto/balanced',
            org_auto_model: {
              routes: {},
              fallback_model: 'kilo-auto/balanced',
            },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'organization_auto_configuration_error',
      message: 'Organization Auto is not enabled for this organization.',
    });
  });

  it('rejects self-referential route targets at runtime', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'code',
        apiKind: 'chat_completions',
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            default_model: ORG_AUTO_MODEL.id,
            org_auto_model: {
              routes: { code: ORG_AUTO_MODEL.id },
              fallback_model: 'kilo-auto/balanced',
            },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'organization_auto_configuration_error',
      message: 'Organization Auto cannot target itself.',
    });
  });
});
