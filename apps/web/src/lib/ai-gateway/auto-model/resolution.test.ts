import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/lib/ai-gateway/providers/gateway-models-cache', () => ({
  getOpenRouterModels: jest.fn(async () => new Set<string>()),
}));

jest.mock('@/lib/kiloclaw/setup-promo', () => ({
  userIsWithinFirstKiloClawInstanceWindow: jest.fn(async () => false),
}));

import { resolveAutoModel } from './resolution';
import {
  BALANCED_QWEN_MODEL,
  FRONTIER_CODE_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  ORG_AUTO_MODEL,
} from '@/lib/ai-gateway/auto-model';
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
  tier: 'low',
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

describe('resolveAutoModel — Organization Auto branch', () => {
  it('uses canonical built-in routes before legacy aliases', async () => {
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

    expect(result).toEqual({
      kind: 'ok',
      resolved: FRONTIER_CODE_MODEL,
      routingTarget: 'kilo-auto/frontier',
    });
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
