import { describe, expect, it } from 'vitest';

import {
  getModelsSectionCount,
  getSessionCostBreakdown,
  getVisibleSessionCostModels,
  isHiddenAutoModelRow,
  type SessionCostBreakdownModel,
} from './session-cost-breakdown';
import {
  type AssistantMessage,
  type Part,
  type StepFinishPart,
  type StoredMessage,
} from 'cloud-agent-sdk';

/**
 * R8 / AC8 — Models section display filter.
 *
 * Predicate + count derivation are pure and unit-tested here. Filtering is
 * render-only: getSessionCostBreakdown still attributes auto rows so totals
 * and the subagent residual stay correct.
 */

function assistantInfo(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg-1',
    sessionID: 'ses-1',
    role: 'assistant',
    time: { created: 1 },
    parentID: 'msg-0',
    modelID: 'claude-sonnet-4',
    providerID: 'kilo',
    mode: 'code',
    agent: 'test',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function stepFinish(overrides: Partial<StepFinishPart> = {}): StepFinishPart {
  return {
    id: 'p-finish',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'step-finish',
    reason: 'stop',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function stepFinishWithModel(
  model: { providerID: string; modelID: string },
  overrides: Partial<StepFinishPart> = {}
): StepFinishPart {
  return Object.assign(stepFinish(overrides), { model }) as StepFinishPart;
}

function storedMessage(info: AssistantMessage, parts: Part[] = []): StoredMessage {
  return { info, parts };
}

function modelRow(
  overrides: Partial<SessionCostBreakdownModel> &
    Pick<SessionCostBreakdownModel, 'providerID' | 'modelID'>
): SessionCostBreakdownModel {
  return {
    steps: 1,
    costUsd: 0.01,
    tokens: {
      input: 1,
      output: 1,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
    },
    ...overrides,
  };
}

const oneOneTokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };

describe('isHiddenAutoModelRow', () => {
  it('hides kilo provider rows whose modelID starts with kilo-auto/', () => {
    expect(isHiddenAutoModelRow({ providerID: 'kilo', modelID: 'kilo-auto/efficient' })).toBe(true);
    expect(isHiddenAutoModelRow({ providerID: 'kilo', modelID: 'kilo-auto/frontier' })).toBe(true);
    expect(isHiddenAutoModelRow({ providerID: 'kilo', modelID: 'kilo-auto/balanced' })).toBe(true);
  });

  it('keeps routed concrete models on the kilo provider', () => {
    expect(isHiddenAutoModelRow({ providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' })).toBe(
      false
    );
    expect(isHiddenAutoModelRow({ providerID: 'kilo', modelID: 'claude-sonnet-4' })).toBe(false);
    expect(isHiddenAutoModelRow({ providerID: 'kilo', modelID: 'openai/gpt-4o' })).toBe(false);
  });

  it('does not hide auto-prefixed ids on non-kilo providers', () => {
    expect(isHiddenAutoModelRow({ providerID: 'openrouter', modelID: 'kilo-auto/efficient' })).toBe(
      false
    );
    expect(isHiddenAutoModelRow({ providerID: 'anthropic', modelID: 'kilo-auto/efficient' })).toBe(
      false
    );
  });

  it('does not hide non-auto kilo models that merely contain kilo-auto elsewhere', () => {
    expect(
      isHiddenAutoModelRow({ providerID: 'kilo', modelID: 'prefix-kilo-auto/efficient' })
    ).toBe(false);
  });
});

describe('getVisibleSessionCostModels / getModelsSectionCount', () => {
  it('filters auto rows and keeps routed + non-kilo rows', () => {
    const models = [
      modelRow({ providerID: 'kilo', modelID: 'kilo-auto/efficient', steps: 4 }),
      modelRow({ providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4', steps: 2 }),
      modelRow({ providerID: 'openai', modelID: 'gpt-4o', steps: 1 }),
    ];
    const visible = getVisibleSessionCostModels(models);
    expect(visible).toHaveLength(2);
    expect(visible.map(m => m.modelID)).toEqual(['anthropic/claude-sonnet-4', 'gpt-4o']);
  });

  it('derives Models (N) from filtered rows + residual, never unfiltered length', () => {
    const autoOnly = [modelRow({ providerID: 'kilo', modelID: 'kilo-auto/efficient' })];
    // Auto-only, no residual → section hidden (count 0)
    expect(getModelsSectionCount(autoOnly, 0)).toBe(0);
    // Auto-only + residual → count is residual only (1), not 2
    expect(getModelsSectionCount(autoOnly, 0.02)).toBe(1);

    const mixed = [
      modelRow({ providerID: 'kilo', modelID: 'kilo-auto/efficient' }),
      modelRow({ providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4' }),
    ];
    // Filtered list (1) + residual → 2, not unfiltered 2 + residual = 3
    expect(getModelsSectionCount(mixed, 0.02)).toBe(2);
    // Filtered list only → 1
    expect(getModelsSectionCount(mixed, 0)).toBe(1);
  });

  it('returns zero when there are no models and no residual', () => {
    expect(getModelsSectionCount([], 0)).toBe(0);
  });

  it('counts residual alone when models list is empty', () => {
    expect(getModelsSectionCount([], 0.05)).toBe(1);
  });
});

describe('getSessionCostBreakdown (filter is render-only)', () => {
  it('keeps auto-model rows in breakdown totals and residual', () => {
    const messages: StoredMessage[] = [
      storedMessage(
        assistantInfo({
          id: 'm1',
          providerID: 'kilo',
          modelID: 'kilo-auto/efficient',
          cost: 0.04,
        }),
        [
          stepFinishWithModel(
            { providerID: 'kilo', modelID: 'kilo-auto/efficient' },
            { id: 'sf-1', cost: 0.04, tokens: oneOneTokens }
          ),
        ]
      ),
    ];
    const result = getSessionCostBreakdown(messages, 0.06);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.modelID).toBe('kilo-auto/efficient');
    expect(result.attributedCostUsd).toBeCloseTo(0.04, 6);
    expect(result.subagentCostUsd).toBeCloseTo(0.02, 6);
    expect(result.totals.input).toBe(1);
    expect(result.totals.output).toBe(1);
    // Display layer would hide the auto row and show residual only
    expect(getModelsSectionCount(result.models, result.subagentCostUsd)).toBe(1);
    expect(getVisibleSessionCostModels(result.models)).toEqual([]);
  });
});
