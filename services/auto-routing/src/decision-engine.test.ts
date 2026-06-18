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
  routes: {
    'implementation/code_generation': [
      {
        model: 'cheap/chat',
        accuracy: 0.85,
        avgCostUsd: 0.002,
        meetsThreshold: true,
      },
      {
        model: 'mid/chat',
        accuracy: 0.8,
        avgCostUsd: 0.005,
        meetsThreshold: true,
        reasoningEffort: 'medium',
      },
      {
        model: 'pricey/chat',
        accuracy: 0.9,
        avgCostUsd: 0.02,
        meetsThreshold: true,
      },
      {
        model: 'weak/chat',
        accuracy: 0.5,
        avgCostUsd: 0.003,
        meetsThreshold: false,
      },
    ],
    'debugging/bug_fixing': [
      {
        model: 'mid/chat',
        accuracy: 0.8,
        avgCostUsd: 0.01,
        meetsThreshold: true,
      },
    ],
    'planning_design/system_design': [
      {
        model: 'big/chat',
        accuracy: 0.9,
        avgCostUsd: 0.1,
        meetsThreshold: true,
      },
    ],
  },
};

describe('computeDecision', () => {
  it('picks the first candidate of the classifier taxonomy route', () => {
    const decision = computeDecision(classification, table, null);
    expect(decision).toEqual({
      model: 'cheap/chat',
      taskType: 'implementation',
      subtaskType: 'code_generation',
      source: 'benchmark',
      tableVersion: 'run-1',
      reasoningEffort: null,
      sticky: false,
    });
  });
  it('uses the classifier task type and subtype directly', () => {
    const debugging: ClassifierOutput = {
      ...classification,
      taskType: 'debugging',
      subtaskType: 'bug_fixing',
    };
    expect(computeDecision(debugging, table, null)?.model).toBe('mid/chat');
  });
  it('returns null when there is no routing table', () => {
    expect(computeDecision(classification, null, null)).toBeNull();
  });
  it('skips denied fresh candidates', () => {
    const decision = computeDecision(classification, table, null, new Set(['cheap/chat']));
    expect(decision).toEqual({
      model: 'mid/chat',
      taskType: 'implementation',
      subtaskType: 'code_generation',
      source: 'benchmark',
      tableVersion: 'run-1',
      reasoningEffort: 'medium',
      sticky: false,
    });
  });
  it('returns null when every route candidate is denied', () => {
    const decision = computeDecision(
      classification,
      table,
      null,
      new Set(['cheap/chat', 'mid/chat', 'pricey/chat', 'weak/chat'])
    );
    expect(decision).toBeNull();
  });

  describe('session stickiness', () => {
    it('keeps the incumbent on route changes when it is within the switch-cost factor', () => {
      // Fresh pick cheap/chat at 0.002; mid/chat at 0.005 is not cheaper by
      // more than 3x (0.002 * 3 = 0.006 >= 0.005), so the session stays put.
      const decision = computeDecision(classification, table, 'mid/chat');
      expect(decision).toEqual({
        model: 'mid/chat',
        taskType: 'implementation',
        subtaskType: 'code_generation',
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
        routes: {
          ...table.routes,
          'implementation/code_generation': [
            {
              ...table.routes['implementation/code_generation'][0]!,
              model: 'fresh/chat',
              avgCostUsd: 1,
            },
            {
              ...table.routes['implementation/code_generation'][1]!,
              model: 'incumbent/chat',
              avgCostUsd: 3,
            },
          ],
        },
      };
      const decision = computeDecision(classification, boundaryTable, 'incumbent/chat');
      expect(decision).toMatchObject({ model: 'incumbent/chat', sticky: true });
    });
    it('switches when the fresh pick is cheaper by more than the factor', () => {
      // pricey/chat at 0.02 vs fresh 0.002 * 3 = 0.006: switch pays off.
      const decision = computeDecision(classification, table, 'pricey/chat');
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false });
    });
    it('does not keep a denied incumbent', () => {
      const decision = computeDecision(classification, table, 'mid/chat', new Set(['mid/chat']));
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false });
    });
    it('switches when the incumbent no longer meets the route threshold', () => {
      const decision = computeDecision(classification, table, 'weak/chat');
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false });
    });
    it('serves the fresh pick when the incumbent is not in the route', () => {
      const decision = computeDecision(classification, table, 'gone/model');
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false });
    });
    it('is not sticky when the incumbent is the fresh pick', () => {
      const decision = computeDecision(classification, table, 'cheap/chat');
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false });
    });
  });
});
