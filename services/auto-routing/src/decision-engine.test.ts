import { describe, expect, it } from 'vitest';
import type { ClassifierOutput, RoutingTable } from '@kilocode/auto-routing-contracts';
import { computeDecision } from './decision-engine';

const classification: ClassifierOutput = {
  taskType: 'implementation',
  subtaskType: 'code_generation',
  contextComplexity: 'small',
  reasoningComplexity: 'low',
  riskLevel: 'low',
  executionMode: 'answer_only',
  requiresTools: false,
  confidence: 0.9,
};

const table: RoutingTable = {
  version: 'run-1',
  generatedAt: '2026-06-11T00:00:00.000Z',
  minAccuracy: 0.7,
  switchCostFactor: 3,
  source: 'benchmark',
  tiers: {
    low: [
      {
        model: 'cheap/messages-only',
        accuracy: 0.9,
        avgCostUsd: 0.001,
        meetsThreshold: true,
        supportedApiKinds: ['messages'],
      },
      {
        model: 'cheap/chat',
        accuracy: 0.85,
        avgCostUsd: 0.002,
        meetsThreshold: true,
        supportedApiKinds: ['chat_completions'],
      },
      {
        model: 'mid/chat',
        accuracy: 0.8,
        avgCostUsd: 0.005,
        meetsThreshold: true,
        supportedApiKinds: ['chat_completions', 'messages'],
        reasoningEffort: 'medium',
      },
      {
        model: 'pricey/chat',
        accuracy: 0.9,
        avgCostUsd: 0.02,
        meetsThreshold: true,
        supportedApiKinds: ['chat_completions'],
      },
      {
        model: 'weak/chat',
        accuracy: 0.5,
        avgCostUsd: 0.003,
        meetsThreshold: false,
        supportedApiKinds: ['chat_completions'],
      },
    ],
    medium: [
      {
        model: 'mid/chat',
        accuracy: 0.8,
        avgCostUsd: 0.01,
        meetsThreshold: true,
        supportedApiKinds: ['chat_completions', 'messages'],
      },
    ],
    high: [
      {
        model: 'big/chat',
        accuracy: 0.9,
        avgCostUsd: 0.1,
        meetsThreshold: true,
        supportedApiKinds: ['chat_completions'],
      },
    ],
  },
};

describe('computeDecision', () => {
  it('picks the first candidate supporting the request api kind', () => {
    const decision = computeDecision(classification, 'chat_completions', table, null);
    expect(decision).toEqual({
      model: 'cheap/chat',
      tier: 'low',
      source: 'benchmark',
      tableVersion: 'run-1',
      reasoningEffort: null,
      sticky: false,
    });
  });
  it('uses the tier derived from the classification', () => {
    const hard: ClassifierOutput = {
      ...classification,
      reasoningComplexity: 'high',
      contextComplexity: 'large',
      executionMode: 'multi_step_project',
    };
    expect(computeDecision(hard, 'chat_completions', table, null)?.model).toBe('big/chat');
  });
  it('returns null when no candidate supports the api kind', () => {
    expect(computeDecision(classification, 'responses', table, null)).toBeNull();
  });
  it('returns null when there is no routing table', () => {
    expect(computeDecision(classification, 'chat_completions', null, null)).toBeNull();
  });

  describe('session stickiness', () => {
    it('keeps the incumbent on tier de-escalation when it is within the switch-cost factor', () => {
      // Fresh pick cheap/chat at 0.002; mid/chat at 0.005 is not cheaper by
      // more than 3x (0.002 * 3 = 0.006 >= 0.005), so the session stays put.
      const decision = computeDecision(classification, 'chat_completions', table, 'mid/chat');
      expect(decision).toEqual({
        model: 'mid/chat',
        tier: 'low',
        source: 'benchmark',
        tableVersion: 'run-1',
        // The incumbent's benchmarked effort, not the fresh pick's.
        reasoningEffort: 'medium',
        sticky: true,
      });
    });
    it('keeps the incumbent at the exact switch-cost boundary', () => {
      // Strict comparison: switch only when fresh * factor < incumbent.
      // Integer costs avoid float noise on the equality case (1 * 3 === 3).
      const boundaryTable: RoutingTable = {
        ...table,
        tiers: {
          ...table.tiers,
          low: [
            { ...table.tiers.low[1]!, model: 'fresh/chat', avgCostUsd: 1 },
            { ...table.tiers.low[2]!, model: 'incumbent/chat', avgCostUsd: 3 },
          ],
        },
      };
      const decision = computeDecision(
        classification,
        'chat_completions',
        boundaryTable,
        'incumbent/chat'
      );
      expect(decision).toMatchObject({ model: 'incumbent/chat', sticky: true });
    });
    it('switches when the fresh pick is cheaper by more than the factor', () => {
      // pricey/chat at 0.02 vs fresh 0.002 * 3 = 0.006: switch pays off.
      const decision = computeDecision(classification, 'chat_completions', table, 'pricey/chat');
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false });
    });
    it('switches when the incumbent no longer meets the tier threshold', () => {
      const decision = computeDecision(classification, 'chat_completions', table, 'weak/chat');
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false });
    });
    it('serves the fresh pick when the incumbent is not in the tier', () => {
      const decision = computeDecision(classification, 'chat_completions', table, 'gone/model');
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false });
    });
    it('is not sticky when the incumbent is the fresh pick', () => {
      const decision = computeDecision(classification, 'chat_completions', table, 'cheap/chat');
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false });
    });
    it('serves the fresh pick when the incumbent does not support the api kind', () => {
      const decision = computeDecision(
        classification,
        'chat_completions',
        table,
        'cheap/messages-only'
      );
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false });
    });
  });
});
