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
    const decision = computeDecision(classification, 'chat_completions', table);
    expect(decision).toEqual({
      model: 'cheap/chat',
      tier: 'low',
      source: 'benchmark',
      tableVersion: 'run-1',
      reasoningEffort: null,
    });
  });
  it('uses the tier derived from the classification', () => {
    const hard: ClassifierOutput = {
      ...classification,
      reasoningComplexity: 'high',
      contextComplexity: 'large',
      executionMode: 'multi_step_project',
    };
    expect(computeDecision(hard, 'chat_completions', table)?.model).toBe('big/chat');
  });
  it('returns null when no candidate supports the api kind', () => {
    expect(computeDecision(classification, 'responses', table)).toBeNull();
  });
});
