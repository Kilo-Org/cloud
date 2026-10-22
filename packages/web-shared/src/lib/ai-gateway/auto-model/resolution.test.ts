import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as GatewayModelsCache from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type * as AutoFreeConfigModule from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCache>(
    '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getOpenRouterModelsFromDatabase: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config', () => ({
  ...jest.requireActual<typeof AutoFreeConfigModule>(
    '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config'
  ),
  getConfiguredAutoFreeModels: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-routers', () => ({
  findCustomRouter: jest.fn(),
}));

import type * as AutoModelResolution from './resolution';
import {
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_FRONTIER_MODEL,
  ORG_AUTO_MODEL,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type {
  AutoRoutingDecision,
  CustomRouterDefinition,
  CustomRouterReference,
} from '@kilocode/auto-routing-contracts';
import type { CustomRouterResolution } from './custom-router';
import type * as CustomRouters from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { PRIMARY_DEFAULT_MODEL } from '@kilocode/web-shared/lib/ai-gateway/models';

const { resolveAutoModel, applyResolvedAutoModel } =
  jest.requireActual<typeof AutoModelResolution>('./resolution');

const baseParams = {
  model: KILO_AUTO_EFFICIENT_MODEL.id,
  modeHeader: null,
  sessionId: null,
  clientIp: null,
  isAutoFreeCandidateAllowed: null,
};

const nullUserPromise = Promise.resolve(null);
const zeroBalancePromise = Promise.resolve(0);
const primaryDefaultFallback = { model: PRIMARY_DEFAULT_MODEL };
const { getOpenRouterModelsFromDatabase: mockedGetOpenRouterModels } = jest.requireMock<
  jest.Mocked<typeof GatewayModelsCache>
>('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache');
const { getConfiguredAutoFreeModels: mockedGetConfiguredAutoFreeModels } = jest.requireMock<
  jest.Mocked<typeof AutoFreeConfigModule>
>('@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config');
const { findCustomRouter: mockedFindCustomRouter } = jest.requireMock<
  jest.Mocked<typeof CustomRouters>
>('@kilocode/web-shared/lib/ai-gateway/custom-routers');

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

  it('falls back to PRIMARY_DEFAULT_MODEL when no thunk is provided and apiKind=responses', async () => {
    const result = await resolveAutoModel(
      { ...baseParams, apiKind: 'responses' },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: primaryDefaultFallback });
  });

  it('falls back to PRIMARY_DEFAULT_MODEL when no thunk is provided and apiKind=messages', async () => {
    const result = await resolveAutoModel(
      { ...baseParams, apiKind: 'messages' },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: primaryDefaultFallback });
  });

  it('falls back to PRIMARY_DEFAULT_MODEL when no thunk is provided and apiKind=chat_completions', async () => {
    const result = await resolveAutoModel(
      { ...baseParams, apiKind: 'chat_completions' },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: primaryDefaultFallback });
  });

  it.each([KILO_AUTO_BALANCED_MODEL.id, KILO_AUTO_EFFICIENT_MODEL.id])(
    'falls back to PRIMARY_DEFAULT_MODEL for %s when the worker returns no decision',
    async model => {
      const result = await resolveAutoModel(
        {
          ...baseParams,
          model,
          apiKind: 'chat_completions',
          efficientDecision: async () => null,
        },
        nullUserPromise,
        zeroBalancePromise
      );

      expect(result).toEqual({ kind: 'ok', resolved: primaryDefaultFallback });
    }
  );

  it('falls back to PRIMARY_DEFAULT_MODEL when the worker returns a virtual auto model', async () => {
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

    expect(result).toEqual({ kind: 'ok', resolved: primaryDefaultFallback });
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
    // Claude catalog: xhigh → effort xhigh + verbosity xhigh; max → effort max + verbosity max
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
        reasoning: { enabled: true, effort: 'max' },
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
        reasoning: { enabled: true, effort: 'max' },
        verbosity: 'max',
      },
    });
  });

  it('falls back to PRIMARY_DEFAULT_MODEL when variant is absent from the model catalog', async () => {
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

    expect(result).toEqual({ kind: 'ok', resolved: primaryDefaultFallback });
  });

  it('falls back to PRIMARY_DEFAULT_MODEL when the model exposes no variants but decision has a variant', async () => {
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

    expect(result).toEqual({ kind: 'ok', resolved: primaryDefaultFallback });
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

    expect(result).toEqual({ kind: 'ok', resolved: primaryDefaultFallback });
  });
});

describe('resolveAutoModel — kilo-auto/frontier branch', () => {
  it.each(['code', 'architect', null] as const)(
    'fails closed without a frontier decision for mode %s',
    async modeHeader => {
      const efficientDecision = jest.fn(async () => sampleDecision);
      const result = await resolveAutoModel(
        {
          ...baseParams,
          model: KILO_AUTO_FRONTIER_MODEL.id,
          modeHeader,
          apiKind: 'chat_completions',
          efficientDecision,
        },
        nullUserPromise,
        zeroBalancePromise
      );

      expect(result).toEqual({ kind: 'auto_routing_unavailable' });
      expect(efficientDecision).not.toHaveBeenCalled();
    }
  );

  it('resolves the frontier decision without consulting efficient routing', async () => {
    const frontierDecision = jest.fn(async () => ({
      ...sampleDecision,
      model: 'anthropic/claude-sonnet-5',
      variant: 'xhigh',
    }));
    const efficientDecision = jest.fn(async () => sampleDecision);
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: KILO_AUTO_FRONTIER_MODEL.id,
        apiKind: 'chat_completions',
        frontierDecision,
        efficientDecision,
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'ok',
      resolved: {
        model: 'anthropic/claude-sonnet-5',
        reasoning: { enabled: true, effort: 'xhigh' },
        verbosity: 'xhigh',
      },
    });
    expect(frontierDecision).toHaveBeenCalledTimes(1);
    expect(efficientDecision).not.toHaveBeenCalled();
  });

  it.each([
    ['missing frontier table', null],
    ['virtual model', { ...sampleDecision, model: KILO_AUTO_EFFICIENT_MODEL.id }],
    ['missing catalog variant', { ...sampleDecision, variant: 'missing-variant' }],
  ] as const)('fails closed without legacy routing for %s', async (_, decision) => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: KILO_AUTO_FRONTIER_MODEL.id,
        modeHeader: 'architect',
        apiKind: 'chat_completions',
        frontierDecision: async () => decision,
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'auto_routing_unavailable' });
  });

  it('keeps efficient routing independent of a supplied frontier decision', async () => {
    const frontierDecision = jest.fn(async () => sampleDecision);
    const result = await resolveAutoModel(
      { ...baseParams, apiKind: 'chat_completions', frontierDecision },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({ kind: 'ok', resolved: primaryDefaultFallback });
    expect(frontierDecision).not.toHaveBeenCalled();
  });
});

describe('resolveAutoModel — kilo-auto/free branch', () => {
  beforeEach(() => {
    mockedGetOpenRouterModels.mockResolvedValue(
      new Set(['poolside/laguna-s-2.1:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'])
    );
    mockedGetConfiguredAutoFreeModels.mockResolvedValue([
      {
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        weight: 1,
        reasoning: { enabled: true, effort: 'high' },
      },
      {
        model: 'poolside/laguna-s-2.1:free',
        weight: 1,
        reasoning: { enabled: true, effort: 'high' },
      },
      { model: 'test/absent:free', weight: 1, reasoning: { enabled: true } },
    ]);
  });

  it('excludes candidates denied by the effective organization policy', async () => {
    const isAutoFreeCandidateAllowed = jest.fn(
      async (modelId: string) => modelId === 'poolside/laguna-s-2.1:free'
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
      resolved: {
        model: 'poolside/laguna-s-2.1:free',
        reasoning: { enabled: true, effort: 'high' },
      },
    });
    expect(isAutoFreeCandidateAllowed).toHaveBeenCalledWith('poolside/laguna-s-2.1:free');
  });

  it('reports no free models when organization policy denies every candidate and the fallback', async () => {
    const isAutoFreeCandidateAllowed = jest.fn(async (_modelId: string) => false);
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

    expect(result).toEqual({ kind: 'no_free_models_available' });
    expect(isAutoFreeCandidateAllowed).toHaveBeenCalledWith('openrouter/free');
  });

  it('falls back to openrouter/free when organization policy denies every configured model', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: KILO_AUTO_FREE_MODEL.id,
        apiKind: 'chat_completions',
        isAutoFreeCandidateAllowed: async modelId => modelId === 'openrouter/free',
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'ok',
      resolved: { model: 'openrouter/free', reasoning: { enabled: true } },
    });
  });

  it.each([
    ['nothing is configured', null],
    [
      'no configured model is available',
      [{ model: 'test/absent:free', weight: 1, reasoning: { enabled: true } }],
    ],
  ])('falls back to openrouter/free when %s', async (_, configuredModels) => {
    mockedGetConfiguredAutoFreeModels.mockResolvedValue(configuredModels);

    const result = await resolveAutoModel(
      { ...baseParams, model: KILO_AUTO_FREE_MODEL.id, apiKind: 'chat_completions' },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'ok',
      resolved: { model: 'openrouter/free', reasoning: { enabled: true } },
    });
  });

  it('skips configured models that are unavailable', async () => {
    mockedGetConfiguredAutoFreeModels.mockResolvedValue([
      { model: 'test/absent:free', weight: 100, reasoning: { enabled: true } },
      { model: 'poolside/laguna-s-2.1:free', weight: 1, reasoning: { enabled: false } },
    ]);

    const result = await resolveAutoModel(
      { ...baseParams, model: KILO_AUTO_FREE_MODEL.id, apiKind: 'chat_completions' },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toEqual({
      kind: 'ok',
      resolved: { model: 'poolside/laguna-s-2.1:free', reasoning: { enabled: false } },
    });
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
        frontierDecision: async () => sampleDecision,
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
      resolved: { model: sampleDecision.model },
      routingTarget: 'kilo-auto/frontier',
    });
  });

  it('does not fall back from an unavailable organization frontier route', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'code',
        apiKind: 'chat_completions',
        frontierDecision: async () => null,
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

    expect(result).toEqual({ kind: 'auto_routing_unavailable' });
  });

  it('falls build back to the canonical code route', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'build',
        apiKind: 'chat_completions',
        frontierDecision: async () => sampleDecision,
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
        frontierDecision: async () => sampleDecision,
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
      resolved: primaryDefaultFallback,
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

describe('resolveAutoModel — custom routers', () => {
  const haiku = 'anthropic/claude-haiku-4.5';
  const customDecision: AutoRoutingDecision = {
    ...sampleDecision,
    model: haiku,
    entry: { kind: 'gateway', model: haiku },
    variant: 'max',
    stale: false,
    fallback: false,
  };
  const orgRouter: CustomRouterDefinition = {
    id: '00000000-0000-4000-8000-000000000002',
    ownerType: 'org',
    ownerId: 'org-1',
    slug: 'team',
    name: 'Team',
    baseRouter: 'efficient',
    mode: 'cost_per_accuracy',
    entries: [{ kind: 'gateway', model: haiku }],
    defaultEntryKey: `gateway:${haiku}`,
  };
  const okDecide = () =>
    jest.fn(async (_reference: CustomRouterReference): Promise<CustomRouterResolution> => ({
      kind: 'ok',
      decision: customDecision,
    }));

  function resolveCustom(
    model: string,
    customRouterDecision: (reference: CustomRouterReference) => Promise<CustomRouterResolution>
  ) {
    return resolveAutoModel(
      {
        ...baseParams,
        model,
        apiKind: 'chat_completions',
        efficientDecision: async () => sampleDecision,
        customRouterDecision,
      },
      nullUserPromise,
      zeroBalancePromise
    );
  }

  beforeEach(() => {
    mockedFindCustomRouter.mockReset();
  });

  it('serves the worker decision with its exact catalog variant', async () => {
    const decide = okDecide();

    const result = await resolveCustom('kilo-auto/custom/org/team', decide);

    expect(decide).toHaveBeenCalledWith({ scope: 'org', slug: 'team' });
    expect(result).toEqual({
      kind: 'ok',
      resolved: { model: haiku, reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
    });
  });

  it('parses personal router ids', async () => {
    const decide = okDecide();

    await resolveCustom('kilo-auto/custom/mine', decide);

    expect(decide).toHaveBeenCalledWith({ scope: 'user', slug: 'mine' });
  });

  it.each(['kilo-auto/custom/org', 'kilo-auto/custom/Not_A_Slug', 'kilo-auto/custom/'])(
    'answers router_not_found for the invalid id %s without deciding',
    async model => {
      const decide = okDecide();

      expect(await resolveCustom(model, decide)).toEqual({
        kind: 'custom_router_error',
        code: 'router_not_found',
        message: 'Custom router not found',
      });
      expect(decide).not.toHaveBeenCalled();
    }
  );

  it('surfaces worker rejections instead of a fallback model', async () => {
    const result = await resolveCustom('kilo-auto/custom/mine', async () => ({
      kind: 'rejected',
      code: 'custom_router_unavailable',
      message: 'No entry of this custom router is available to this client',
    }));

    expect(result).toEqual({
      kind: 'custom_router_error',
      code: 'custom_router_unavailable',
      message: 'No entry of this custom router is available to this client',
    });
  });

  it('reports an unreachable worker as unavailable instead of the balanced fallback', async () => {
    const result = await resolveCustom('kilo-auto/custom/mine', async () => ({
      kind: 'unavailable',
    }));

    expect(result).toEqual({ kind: 'auto_routing_unavailable' });
  });

  it('refuses a decision variant missing from the catalog instead of serving defaults', async () => {
    const result = await resolveCustom('kilo-auto/custom/mine', async () => ({
      kind: 'ok',
      decision: {
        ...customDecision,
        model: 'anthropic/claude-sonnet-5',
        entry: { kind: 'gateway', model: 'anthropic/claude-sonnet-5' },
        variant: 'thinking',
      },
    }));

    expect(result).toMatchObject({
      kind: 'custom_router_error',
      code: 'custom_router_unavailable',
    });
  });

  it('uses the shared migrated pool when Organization Auto targets Balanced', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        apiKind: 'chat_completions',
        legacyPoolRouter: async () => ({ scope: 'org', slug: 'efficient' }),
        customRouterDecision: okDecide(),
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            default_model: ORG_AUTO_MODEL.id,
            org_auto_model: {
              routes: {},
              fallback_model: KILO_AUTO_BALANCED_MODEL.id,
            },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );
    expect(result).toEqual({
      kind: 'ok',
      resolved: { model: haiku, reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
      routingTarget: KILO_AUTO_BALANCED_MODEL.id,
    });
  });

  it('fails closed when the migrated-pool lookup fails before Efficient resolution', async () => {
    const result = await resolveAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        legacyPoolRouter: async () => {
          throw new Error('storage unavailable');
        },
        efficientDecision: async () => sampleDecision,
      },
      nullUserPromise,
      zeroBalancePromise
    );
    expect(result).toEqual({ kind: 'auto_routing_unavailable' });
  });

  it('resolves an Organization Auto route to an organization custom router', async () => {
    mockedFindCustomRouter.mockResolvedValue(orgRouter);
    const decide = okDecide();

    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'code',
        apiKind: 'chat_completions',
        customRouterDecision: decide,
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            default_model: ORG_AUTO_MODEL.id,
            model_deny_list: ['openai/gpt-4o'],
            org_auto_model: {
              routes: { code: 'kilo-auto/custom/org/team' },
              fallback_model: 'kilo-auto/balanced',
            },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(mockedFindCustomRouter).toHaveBeenCalledWith(
      { type: 'org', id: 'org-1' },
      'team',
      expect.anything()
    );
    expect(decide).toHaveBeenCalledWith({ scope: 'org', slug: 'team' });
    expect(result).toEqual({
      kind: 'ok',
      resolved: { model: haiku, reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
      routingTarget: 'kilo-auto/custom/org/team',
    });
  });

  it.each([
    ['a personal router', 'kilo-auto/custom/mine'],
    ['a router of another organization', 'kilo-auto/custom/org/team'],
  ])('rejects an Organization Auto route to %s', async (_name, target) => {
    mockedFindCustomRouter.mockResolvedValue(null);
    const decide = okDecide();

    const result = await resolveAutoModel(
      {
        ...baseParams,
        model: ORG_AUTO_MODEL.id,
        modeHeader: 'code',
        apiKind: 'chat_completions',
        customRouterDecision: decide,
        organizationContext: Promise.resolve({
          organizationId: 'org-1',
          plan: 'enterprise',
          settings: {
            default_model: ORG_AUTO_MODEL.id,
            org_auto_model: { routes: { code: target }, fallback_model: 'kilo-auto/balanced' },
          },
        }),
      },
      nullUserPromise,
      zeroBalancePromise
    );

    expect(result).toMatchObject({ kind: 'organization_auto_configuration_error' });
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('applyResolvedAutoModel', () => {
  it('replaces reasoning_effort with the resolved reasoning config for chat completions', async () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: KILO_AUTO_FRONTIER_MODEL.id,
        messages: [],
        reasoning_effort: 'high',
      },
    };

    await applyResolvedAutoModel(
      {
        ...baseParams,
        model: KILO_AUTO_FRONTIER_MODEL.id,
        modeHeader: 'code',
        apiKind: 'chat_completions',
        frontierDecision: async () => ({
          ...sampleDecision,
          reasoningEffort: 'high',
        }),
      },
      request,
      nullUserPromise,
      zeroBalancePromise
    );

    expect(request.body).toMatchObject({
      model: sampleDecision.model,
      reasoning: { enabled: true, effort: 'high' },
    });
    expect(request.body).not.toHaveProperty('reasoning_effort');
  });

  it('keeps reasoning_effort for chat completions when no reasoning config is resolved', async () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: KILO_AUTO_EFFICIENT_MODEL.id,
        messages: [],
        reasoning_effort: 'high',
      },
    };

    await applyResolvedAutoModel(
      {
        ...baseParams,
        apiKind: 'chat_completions',
        efficientDecision: async () => sampleDecision,
      },
      request,
      nullUserPromise,
      zeroBalancePromise
    );

    expect(request.body).toMatchObject({
      model: sampleDecision.model,
      reasoning_effort: 'high',
    });
    expect(request.body).not.toHaveProperty('reasoning');
  });
});
