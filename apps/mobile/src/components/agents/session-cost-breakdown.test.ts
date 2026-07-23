import { describe, expect, it } from 'vitest';

import { getSessionCostBreakdown } from './session-cost-breakdown';
import {
  type AssistantMessage,
  type Part,
  type StepFinishPart,
  type StoredMessage,
} from 'cloud-agent-sdk';

/**
 * F2 — cost breakdown helper.
 *
 * Correctness-critical contract:
 *   Σ(per-model costUsd) + subagentCostUsd === totalCostUsd
 *
 * This must hold when there is no subagent delta and when there is one
 * (subagent cost is folded into the parent message but never written onto
 * a step-finish part, so totalCostUsd > Σ(step-finish cost) in that case).
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

function storedMessage(info: AssistantMessage, parts: Part[] = []): StoredMessage {
  return { info, parts };
}

// Build a step-finish with the (runtime-only) `model` field. The field is
// present on the wire and in the Zod contract but absent from the generated
// StepFinishPart type, so we cast the merged shape — same pattern as the
// existing part-utils tests.
function stepFinishWithModel(
  model: { providerID: string; modelID: string },
  overrides: Partial<StepFinishPart> = {}
): StepFinishPart {
  const merged: StepFinishPart = Object.assign(stepFinish(overrides), { model }) as StepFinishPart;
  return merged;
}

describe('getSessionCostBreakdown', () => {
  it('returns zero totals and zero subagent cost for an empty message list', () => {
    const result = getSessionCostBreakdown([], 0);
    expect(result.totals).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cacheRatePct: null,
    });
    expect(result.models).toEqual([]);
    expect(result.attributedCostUsd).toBe(0);
    expect(result.subagentCostUsd).toBe(0);
  });

  it('returns cacheRatePct = null when the denominator is zero (no input or cache tokens)', () => {
    const info = assistantInfo({
      tokens: { input: 0, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const result = getSessionCostBreakdown(
      [
        storedMessage(info, [
          stepFinish({
            tokens: { input: 0, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
        ]),
      ],
      0
    );
    expect(result.totals.cacheRatePct).toBeNull();
  });

  it('computes cacheRatePct = cacheRead / (input + cacheRead + cacheWrite) * 100', () => {
    const tokens = { input: 10, output: 0, reasoning: 0, cache: { read: 30, write: 5 } };
    const info = assistantInfo({ tokens });
    const result = getSessionCostBreakdown([storedMessage(info, [stepFinish({ tokens })])], 0);
    // 30 / (10 + 30 + 5) * 100 = 66.666...
    expect(result.totals.cacheRatePct).toBeCloseTo(66.6666, 3);
  });

  it('groups by routed model when a step-finish part carries a model accessor', () => {
    // Message requested kilo/claude-sonnet-4 but the CLI routed a step to anthropic/claude-sonnet-4.
    const info = assistantInfo({
      providerID: 'kilo',
      modelID: 'claude-sonnet-4',
      cost: 0.01,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const routedPart = stepFinishWithModel(
      { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      {
        cost: 0.007,
        tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      }
    );
    const infoOnlyMessage = storedMessage(
      assistantInfo({
        id: 'msg-2',
        providerID: 'kilo',
        modelID: 'claude-sonnet-4',
        cost: 0.003,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    );

    const result = getSessionCostBreakdown(
      [storedMessage(info, [routedPart]), infoOnlyMessage],
      0.01
    );

    // The routed step groups under anthropic/claude-sonnet-4; the info-only
    // message groups under kilo/claude-sonnet-4.
    expect(result.models).toHaveLength(2);
    const anthropic = result.models.find(m => m.providerID === 'anthropic');
    const kilo = result.models.find(m => m.providerID === 'kilo');
    expect(anthropic?.costUsd).toBeCloseTo(0.007, 6);
    expect(anthropic?.steps).toBe(1);
    expect(kilo?.costUsd).toBeCloseTo(0.003, 6);
    expect(kilo?.steps).toBe(1);
    // Total attributed is 0.01 = session total → no subagent residual.
    expect(result.attributedCostUsd).toBeCloseTo(0.01, 6);
    expect(result.subagentCostUsd).toBeCloseTo(0, 6);
  });

  it('falls back to message.info as one step when a message has no step-finish parts', () => {
    const info = assistantInfo({
      cost: 0.05,
      tokens: { input: 5, output: 6, reasoning: 1, cache: { read: 2, write: 1 } },
    });
    const result = getSessionCostBreakdown([storedMessage(info)], 0.05);
    expect(result.models).toHaveLength(1);
    const first = result.models[0];
    expect(first).toBeDefined();
    expect(first?.providerID).toBe('kilo');
    expect(first?.modelID).toBe('claude-sonnet-4');
    expect(first?.steps).toBe(1);
    expect(first?.costUsd).toBe(0.05);
    expect(first?.tokens).toEqual({
      input: 5,
      output: 6,
      reasoning: 1,
      cacheRead: 2,
      cacheWrite: 1,
      total: 15,
    });
    expect(result.totals.total).toBe(15);
  });

  it('skips user messages and non-assistant roles', () => {
    const userMessage: StoredMessage = {
      info: {
        id: 'u-1',
        sessionID: 'ses-1',
        role: 'user',
        time: { created: 1 },
        agent: 'test',
        model: { providerID: 'kilo', modelID: 'claude-sonnet-4' },
      },
      parts: [],
    };
    const result = getSessionCostBreakdown([userMessage], 0);
    expect(result.models).toEqual([]);
    expect(result.totals.total).toBe(0);
  });

  it('ignores non-step-finish parts (e.g. text, tool) on assistant messages', () => {
    const info = assistantInfo({
      cost: 0.02,
      tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const textPart: Part = {
      id: 'p-text',
      sessionID: 'ses-1',
      messageID: 'msg-1',
      type: 'text',
      text: 'hello',
    };
    const result = getSessionCostBreakdown([storedMessage(info, [textPart])], 0.02);
    // Falls back to message.info as one step.
    expect(result.models).toHaveLength(1);
    const first = result.models[0];
    expect(first?.steps).toBe(1);
    expect(first?.costUsd).toBe(0.02);
  });

  it('reconciles WITHOUT a subagent delta: sum(per-model) + subagent = totalCost', () => {
    const messages: StoredMessage[] = [
      storedMessage(assistantInfo({ id: 'm1', cost: 0.01 }), [
        stepFinish({
          id: 'sf-1',
          cost: 0.01,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ]),
      storedMessage(assistantInfo({ id: 'm2', cost: 0.02 }), [
        stepFinish({
          id: 'sf-2',
          cost: 0.02,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ]),
    ];
    const result = getSessionCostBreakdown(messages, 0.03);
    const sum = result.models.reduce((s, m) => s + m.costUsd, 0);
    expect(sum + result.subagentCostUsd).toBeCloseTo(
      result.attributedCostUsd + result.subagentCostUsd,
      6
    );
    // And the key invariant: attributed + subagent === totalCost.
    expect(result.attributedCostUsd + result.subagentCostUsd).toBeCloseTo(0.03, 6);
    expect(result.subagentCostUsd).toBeCloseTo(0, 6);
  });

  it('reconciles WITH a subagent delta: sum(per-model) + subagent = totalCost', () => {
    // Step-finish cost sums to 0.05, but the parent message folded an
    // additional 0.02 of subagent cost into the assistant total, so
    // totalCost = 0.07. The 0.02 must surface as subagentCostUsd.
    const messages: StoredMessage[] = [
      storedMessage(assistantInfo({ id: 'm1', cost: 0.07 }), [
        stepFinish({
          id: 'sf-1',
          cost: 0.05,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ]),
    ];
    const result = getSessionCostBreakdown(messages, 0.07);
    expect(result.attributedCostUsd).toBeCloseTo(0.05, 6);
    expect(result.subagentCostUsd).toBeCloseTo(0.02, 6);
    expect(result.attributedCostUsd + result.subagentCostUsd).toBeCloseTo(0.07, 6);
  });

  it('clamps subagentCostUsd to 0 when attributed exceeds totalCost (defensive)', () => {
    // If a step-finish cost somehow sums to more than the session total,
    // the residual must not be negative.
    const messages: StoredMessage[] = [
      storedMessage(assistantInfo({ id: 'm1', cost: 0.1 }), [
        stepFinish({
          id: 'sf-1',
          cost: 0.1,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ]),
    ];
    const result = getSessionCostBreakdown(messages, 0.05);
    expect(result.subagentCostUsd).toBe(0);
    expect(result.attributedCostUsd + result.subagentCostUsd).toBeCloseTo(
      result.attributedCostUsd,
      6
    );
  });

  it('groups multiple step-finish parts of one message under their own routed models', () => {
    // Two step-finish parts on the same message, each with a different
    // routed model: they should group independently.
    const info = assistantInfo({
      cost: 0.06,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const partA = stepFinishWithModel(
      { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      {
        id: 'sf-a',
        cost: 0.02,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }
    );
    const partB = stepFinishWithModel(
      { providerID: 'openai', modelID: 'gpt-4o' },
      {
        id: 'sf-b',
        cost: 0.04,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }
    );
    const result = getSessionCostBreakdown([storedMessage(info, [partA, partB])], 0.06);
    expect(result.models).toHaveLength(2);
    const anthropic = result.models.find(m => m.providerID === 'anthropic');
    const openai = result.models.find(m => m.providerID === 'openai');
    expect(anthropic?.costUsd).toBeCloseTo(0.02, 6);
    expect(anthropic?.steps).toBe(1);
    expect(openai?.costUsd).toBeCloseTo(0.04, 6);
    expect(openai?.steps).toBe(1);
    expect(result.attributedCostUsd).toBeCloseTo(0.06, 6);
    expect(result.subagentCostUsd).toBeCloseTo(0, 6);
  });
});
