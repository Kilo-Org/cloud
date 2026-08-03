import { describe, expect, it } from 'vitest';
import type { ClassifierOutput, RoutingTable } from '@kilocode/auto-routing-contracts';
import { computeDecision, type DecisionIncumbent } from './decision-engine';
import type { ModelCapabilities, ModelCapabilitiesMap } from './model-capabilities';

function makeCaps(
  rows: Record<
    string,
    { inputModalities?: string[]; contextLength?: number | null; isActive?: boolean | null }
  >
): ModelCapabilitiesMap {
  const map = new Map<string, ModelCapabilities>();
  for (const [id, row] of Object.entries(rows)) {
    map.set(id, {
      inputModalities: new Set(row.inputModalities ?? []),
      contextLength: row.contextLength ?? null,
      isActive: row.isActive ?? true,
    });
  }
  return map;
}

function inc(model: string | null, variant: string | null = null): DecisionIncumbent | null {
  return model === null ? null : { model, variant };
}

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
  bestAccuracySwitchThreshold: 0.05,
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
      switchReason: null,
    });
  });
  it('defaults to the best accuracy per dollar candidate', () => {
    const decision = computeDecision(classification, table, null);
    expect(decision?.model).toBe('cheap/chat');
  });
  it('picks the most accurate candidate when best accuracy mode is selected', () => {
    const decision = computeDecision(classification, table, null, new Set(), 'best_accuracy');
    expect(decision).toEqual({
      model: 'pricey/chat',
      taskType: 'implementation',
      subtaskType: 'code_generation',
      source: 'benchmark',
      tableVersion: 'run-1',
      reasoningEffort: null,
      sticky: false,
      switchReason: null,
    });
  });
  it('does not keep a lower-accuracy incumbent in best accuracy mode', () => {
    const decision = computeDecision(
      classification,
      table,
      inc('mid/chat'),
      new Set(),
      'best_accuracy'
    );
    expect(decision).toMatchObject({ model: 'pricey/chat', sticky: false, switchReason: 'cost' });
  });
  it('keeps a best-accuracy incumbent when the fresh pick is less than five points better', () => {
    const nearTieTable: RoutingTable = {
      ...table,
      bestAccuracySwitchThreshold: 0.05,
      routes: {
        ...table.routes,
        'implementation/code_generation': [
          {
            model: 'incumbent/chat',
            accuracy: 0.91,
            avgCostUsd: 0.002,
            meetsThreshold: true,
          },
          {
            model: 'fresh/chat',
            accuracy: 0.95,
            avgCostUsd: 0.02,
            meetsThreshold: true,
          },
        ],
      },
    };

    const decision = computeDecision(
      classification,
      nearTieTable,
      inc('incumbent/chat'),
      new Set(),
      'best_accuracy'
    );
    expect(decision).toMatchObject({ model: 'incumbent/chat', sticky: true });
  });
  it('switches best-accuracy mode when the fresh pick clears the accuracy threshold', () => {
    const betterTable: RoutingTable = {
      ...table,
      bestAccuracySwitchThreshold: 0.05,
      routes: {
        ...table.routes,
        'implementation/code_generation': [
          {
            model: 'incumbent/chat',
            accuracy: 0.89,
            avgCostUsd: 0.002,
            meetsThreshold: true,
          },
          {
            model: 'fresh/chat',
            accuracy: 0.95,
            avgCostUsd: 0.02,
            meetsThreshold: true,
          },
        ],
      },
    };

    const decision = computeDecision(
      classification,
      betterTable,
      inc('incumbent/chat'),
      new Set(),
      'best_accuracy'
    );
    expect(decision).toMatchObject({ model: 'fresh/chat', sticky: false });
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
      switchReason: null,
    });
  });
  it('skips virtual auto-model candidates', () => {
    const pollutedTable: RoutingTable = {
      ...table,
      routes: {
        ...table.routes,
        'implementation/code_generation': [
          {
            model: 'kilo-auto/efficient',
            accuracy: 1,
            avgCostUsd: 0.001,
            meetsThreshold: true,
          },
          {
            model: 'concrete/chat',
            accuracy: 0.9,
            avgCostUsd: 0.002,
            meetsThreshold: true,
          },
        ],
      },
    };

    const decision = computeDecision(classification, pollutedTable, null);

    expect(decision).toMatchObject({ model: 'concrete/chat', sticky: false });
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
      const decision = computeDecision(classification, table, inc('mid/chat'));
      expect(decision).toEqual({
        model: 'mid/chat',
        taskType: 'implementation',
        subtaskType: 'code_generation',
        source: 'benchmark',
        tableVersion: 'run-1',
        // The incumbent's benchmarked effort, not the fresh pick's.
        reasoningEffort: 'medium',
        sticky: true,
        switchReason: null,
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
      const decision = computeDecision(classification, boundaryTable, inc('incumbent/chat'));
      expect(decision).toMatchObject({ model: 'incumbent/chat', sticky: true });
    });
    it('switches when the fresh pick is cheaper by more than the factor', () => {
      // pricey/chat at 0.02 vs fresh 0.002 * 3 = 0.006: switch pays off.
      const decision = computeDecision(classification, table, inc('pricey/chat'));
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false, switchReason: 'cost' });
    });
    it('does not keep a denied incumbent', () => {
      const decision = computeDecision(
        classification,
        table,
        inc('mid/chat'),
        new Set(['mid/chat'])
      );
      expect(decision).toMatchObject({
        model: 'cheap/chat',
        sticky: false,
        switchReason: 'threshold',
      });
    });
    it('switches when the incumbent no longer meets the route threshold', () => {
      const decision = computeDecision(classification, table, inc('weak/chat'));
      expect(decision).toMatchObject({
        model: 'cheap/chat',
        sticky: false,
        switchReason: 'threshold',
      });
    });
    it('serves the fresh pick when the incumbent is not in the route', () => {
      const decision = computeDecision(classification, table, inc('gone/model'));
      expect(decision).toMatchObject({
        model: 'cheap/chat',
        sticky: false,
        switchReason: 'threshold',
      });
    });
    it('is not sticky when the incumbent is the fresh pick', () => {
      const decision = computeDecision(classification, table, inc('cheap/chat'));
      expect(decision).toMatchObject({ model: 'cheap/chat', sticky: false, switchReason: null });
    });
  });

  describe('benchmark noise band', () => {
    // Every fixture below is taken verbatim from the live routing table
    // (decider-2026-07-22T10-51-06-305Z, minAccuracy 0.95): accuracies are the
    // published k/30 roundings and costs the published avgCostUsd. In
    // cost_per_accuracy mode the fresh pick is candidates[0] after filtering,
    // so each route array lists the named fresh pick first.
    const liveClassification = (
      taskType: ClassifierOutput['taskType'],
      subtaskType: ClassifierOutput['subtaskType']
    ): ClassifierOutput => ({ ...classification, taskType, subtaskType });

    it('keeps the incumbent on a zero-passer route when it sits inside the band', () => {
      // investigation/codebase_understanding has no threshold-meeting
      // candidate. kimi-k2.7-code is less accurate AND ~1.16x more expensive
      // per benchmark case than the fresh pick, yet it is kept: 0.8667 clears
      // the 0.85 band floor, and 0.01094 * 3 is not less than 0.01272, so the
      // cost condition does not fire either.
      const zeroPasserTable: RoutingTable = {
        ...table,
        minAccuracy: 0.95,
        routes: {
          'investigation/codebase_understanding': [
            {
              model: 'moonshotai/kimi-k3',
              accuracy: 0.9333,
              avgCostUsd: 0.01094,
              meetsThreshold: false,
            },
            {
              model: 'moonshotai/kimi-k2.7-code',
              accuracy: 0.8667,
              avgCostUsd: 0.01272,
              meetsThreshold: false,
            },
          ],
        },
      };
      const decision = computeDecision(
        liveClassification('investigation', 'codebase_understanding'),
        zeroPasserTable,
        inc('moonshotai/kimi-k2.7-code')
      );
      expect(decision).toMatchObject({
        model: 'moonshotai/kimi-k2.7-code',
        sticky: true,
        switchReason: null,
      });
    });

    it('keeps an in-band incumbent when the route’s sole passer is far more expensive', () => {
      // planning_design/technical_planning has exactly one passer,
      // claude-sonnet-5 at $0.0394/case. Keeping inkling (0.9333, $0.0061)
      // gives up +0.033 accuracy — one graded case out of thirty — and the
      // cost escape cannot help here: 0.0394 * 3 = 0.1182 is not less than
      // 0.0061, so the band is the only thing preventing the switch onto a
      // model 6.5x more expensive.
      const solePasserTable: RoutingTable = {
        ...table,
        minAccuracy: 0.95,
        routes: {
          'planning_design/technical_planning': [
            {
              model: 'anthropic/claude-sonnet-5',
              accuracy: 0.9667,
              avgCostUsd: 0.0394,
              meetsThreshold: true,
            },
            {
              model: 'thinkingmachines/inkling',
              accuracy: 0.9333,
              avgCostUsd: 0.0061,
              meetsThreshold: false,
            },
          ],
        },
      };
      const decision = computeDecision(
        liveClassification('planning_design', 'technical_planning'),
        solePasserTable,
        inc('thinkingmachines/inkling')
      );
      expect(decision).toMatchObject({
        model: 'thinkingmachines/inkling',
        sticky: true,
        switchReason: null,
      });
    });

    it('keeps a below-bar incumbent over a threshold-clearing fresh pick when the gap is 2/30 graded cases', () => {
      // debugging/root_cause_analysis, the modal live case: the fresh pick
      // clears the bar and costs the same to four decimal places
      // ($0.00274548 vs $0.00274055), so the entire benefit of keeping
      // kimi-k2.7-code is prompt-cache continuity. At n=10 distinct graded
      // cases, 27/30 vs 29/30 is a difference the benchmark cannot resolve.
      const modalTable: RoutingTable = {
        ...table,
        minAccuracy: 0.95,
        routes: {
          'debugging/root_cause_analysis': [
            {
              model: 'minimax/minimax-m3',
              accuracy: 0.9667,
              avgCostUsd: 0.00275,
              meetsThreshold: true,
            },
            {
              model: 'moonshotai/kimi-k2.7-code',
              accuracy: 0.9,
              avgCostUsd: 0.00274,
              meetsThreshold: false,
            },
          ],
        },
      };
      const decision = computeDecision(
        liveClassification('debugging', 'root_cause_analysis'),
        modalTable,
        inc('moonshotai/kimi-k2.7-code')
      );
      expect(decision).toMatchObject({
        model: 'moonshotai/kimi-k2.7-code',
        sticky: true,
        switchReason: null,
      });
    });

    it("labels an in-band incumbent's cost-driven ejection as switchReason 'cost', not 'threshold'", () => {
      // planning_design/architecture_design: the incumbent is inside the
      // band, so the old code would have ejected it as 'threshold'; the band
      // makes it eligible, and the ejection is then caused by the unchanged
      // cost condition: 0.00660620 * 3 = 0.01981860 < 0.03943792. Telemetry
      // must therefore read 'cost' — otherwise the before/after measurement
      // of this change reads its own relabels backwards.
      const relabelTable: RoutingTable = {
        ...table,
        minAccuracy: 0.95,
        routes: {
          'planning_design/architecture_design': [
            {
              model: 'thinkingmachines/inkling',
              accuracy: 0.9,
              avgCostUsd: 0.0066062,
              meetsThreshold: false,
            },
            {
              model: 'anthropic/claude-sonnet-5',
              accuracy: 0.9,
              avgCostUsd: 0.03943792,
              meetsThreshold: false,
            },
          ],
        },
      };
      const decision = computeDecision(
        liveClassification('planning_design', 'architecture_design'),
        relabelTable,
        inc('anthropic/claude-sonnet-5')
      );
      expect(decision).toMatchObject({
        model: 'thinkingmachines/inkling',
        sticky: false,
        switchReason: 'cost',
      });
    });

    it('best_accuracy mode still ejects an in-band incumbent below the threshold', () => {
      // Same route and incumbent as the sole-passer keep case above, with
      // the mode flipped and the outcome inverted: the accuracy gap is
      // 0.0334, below the 0.05 bestAccuracySwitchThreshold, so the gap
      // condition alone would keep inkling — only best_accuracy still
      // requiring meetsThreshold can eject it.
      const solePasserTable: RoutingTable = {
        ...table,
        minAccuracy: 0.95,
        routes: {
          'planning_design/technical_planning': [
            {
              model: 'anthropic/claude-sonnet-5',
              accuracy: 0.9667,
              avgCostUsd: 0.0394,
              meetsThreshold: true,
            },
            {
              model: 'thinkingmachines/inkling',
              accuracy: 0.9333,
              avgCostUsd: 0.0061,
              meetsThreshold: false,
            },
          ],
        },
      };
      const decision = computeDecision(
        liveClassification('planning_design', 'technical_planning'),
        solePasserTable,
        inc('thinkingmachines/inkling'),
        new Set(),
        'best_accuracy'
      );
      expect(decision).toMatchObject({
        model: 'anthropic/claude-sonnet-5',
        sticky: false,
        switchReason: 'threshold',
      });
    });
  });

  describe('capability filters', () => {
    const visionTable: RoutingTable = {
      ...table,
      routes: {
        ...table.routes,
        'implementation/code_generation': [
          {
            model: 'text-only/chat',
            accuracy: 0.95,
            avgCostUsd: 0.001,
            meetsThreshold: true,
          },
          {
            model: 'vision/chat',
            accuracy: 0.85,
            avgCostUsd: 0.002,
            meetsThreshold: true,
          },
          {
            model: 'premium-vision/chat',
            accuracy: 0.92,
            avgCostUsd: 0.005,
            meetsThreshold: true,
          },
        ],
      },
    };

    it('skips a non-vision top-ranked candidate when an image is required', () => {
      const caps = makeCaps({
        'text-only/chat': { inputModalities: [] },
        'vision/chat': { inputModalities: ['image'] },
        'premium-vision/chat': { inputModalities: ['image'] },
      });
      const decision = computeDecision(
        classification,
        visionTable,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { requiredInputModalities: ['image'] },
          capabilityMap: caps,
        }
      );
      expect(decision).toMatchObject({ model: 'vision/chat', sticky: false });
    });

    it('accepts a candidate whose capability map lists the image modality (folding happens upstream)', () => {
      // Synonym folding (`image_url` -> `image`) lives in
      // `model-capabilities.ts` and is tested there; here the engine just
      // sees an already-folded capability set and accepts the candidate.
      const caps = makeCaps({
        'text-only/chat': { inputModalities: [] },
        'vision/chat': { inputModalities: ['image'] },
      });
      const decision = computeDecision(
        classification,
        visionTable,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { requiredInputModalities: ['image'] },
          capabilityMap: caps,
        }
      );
      expect(decision).toMatchObject({ model: 'vision/chat', sticky: false });
    });

    it('ignores a required modality outside ENFORCED_MODALITIES instead of failing closed', () => {
      // 'audio' is not in ENFORCED_MODALITIES; the modality filter is a
      // no-op for it, so every candidate still passes the modality check.
      const caps = makeCaps({
        'text-only/chat': { inputModalities: [] },
        'vision/chat': { inputModalities: ['image'] },
      });
      const decision = computeDecision(
        classification,
        visionTable,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { requiredInputModalities: ['audio'] },
          capabilityMap: caps,
        }
      );
      expect(decision).toMatchObject({ model: 'text-only/chat', sticky: false });
    });

    it('fails closed when every candidate is missing the required image modality', () => {
      const caps = makeCaps({
        'text-only/chat': { inputModalities: [] },
        'vision/chat': { inputModalities: [] },
      });
      const decision = computeDecision(
        classification,
        visionTable,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { requiredInputModalities: ['image'] },
          capabilityMap: caps,
        }
      );
      expect(decision).toBeNull();
    });

    it('fails closed when capabilityMap is missing and a required modality is set', () => {
      const decision = computeDecision(
        classification,
        visionTable,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { requiredInputModalities: ['image'] },
        }
      );
      expect(decision).toBeNull();
    });

    it('replaces a non-vision sticky incumbent when the request gains an image requirement', () => {
      // The text-only incumbent would normally be kept (cheap + accurate),
      // but it lacks the image modality required by the new constraints, so
      // the engine must pick a fresh vision candidate.
      const caps = makeCaps({
        'text-only/chat': { inputModalities: [] },
        'vision/chat': { inputModalities: ['image'] },
        'premium-vision/chat': { inputModalities: ['image'] },
      });
      const decision = computeDecision(
        classification,
        visionTable,
        inc('text-only/chat'),
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { requiredInputModalities: ['image'] },
          capabilityMap: caps,
        }
      );
      expect(decision).toMatchObject({
        model: 'vision/chat',
        sticky: false,
        switchReason: 'capability',
      });
    });

    it('a fitting lower-ranked candidate wins over a provably-too-small top candidate', () => {
      const sizedTable: RoutingTable = {
        ...table,
        routes: {
          ...table.routes,
          'implementation/code_generation': [
            { model: 'tiny/chat', accuracy: 0.95, avgCostUsd: 0.001, meetsThreshold: true },
            { model: 'large/chat', accuracy: 0.7, avgCostUsd: 0.003, meetsThreshold: true },
          ],
        },
      };
      const caps = makeCaps({
        'tiny/chat': { inputModalities: [], contextLength: 4_000 },
        'large/chat': { inputModalities: [], contextLength: 1_000_000 },
      });
      const decision = computeDecision(
        classification,
        sizedTable,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { promptTokensEstimate: 50_000 },
          capabilityMap: caps,
        }
      );
      expect(decision).toMatchObject({ model: 'large/chat', sticky: false });
    });

    it('keeps an unknown-context top candidate over a known-fitting lower candidate (no regression)', () => {
      const sizedTable: RoutingTable = {
        ...table,
        routes: {
          ...table.routes,
          'implementation/code_generation': [
            { model: 'unknown-ctx/chat', accuracy: 0.95, avgCostUsd: 0.001, meetsThreshold: true },
            { model: 'large/chat', accuracy: 0.7, avgCostUsd: 0.003, meetsThreshold: true },
          ],
        },
      };
      const caps = makeCaps({
        'unknown-ctx/chat': { inputModalities: [], contextLength: null },
        'large/chat': { inputModalities: [], contextLength: 1_000_000 },
      });
      const decision = computeDecision(
        classification,
        sizedTable,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { promptTokensEstimate: 50_000 },
          capabilityMap: caps,
        }
      );
      expect(decision).toMatchObject({ model: 'unknown-ctx/chat', sticky: false });
    });

    it('replaces a provably-too-small sticky incumbent with a fresh eligible pick', () => {
      const sizedTable: RoutingTable = {
        ...table,
        routes: {
          ...table.routes,
          'implementation/code_generation': [
            { model: 'large/chat', accuracy: 0.9, avgCostUsd: 0.002, meetsThreshold: true },
            { model: 'huge/chat', accuracy: 0.7, avgCostUsd: 0.003, meetsThreshold: true },
          ],
        },
      };
      const caps = makeCaps({
        'large/chat': { inputModalities: [], contextLength: 4_000 },
        'huge/chat': { inputModalities: [], contextLength: 1_000_000 },
      });
      const decision = computeDecision(
        classification,
        sizedTable,
        inc('large/chat'),
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { promptTokensEstimate: 50_000 },
          capabilityMap: caps,
        }
      );
      expect(decision).toMatchObject({
        model: 'huge/chat',
        sticky: false,
        switchReason: 'capability',
      });
    });

    it('falls back to the max-known-context candidate when every known context is too small', () => {
      const sizedTable: RoutingTable = {
        ...table,
        routes: {
          ...table.routes,
          'implementation/code_generation': [
            { model: 'small/chat', accuracy: 0.95, avgCostUsd: 0.001, meetsThreshold: true },
            { model: 'medium/chat', accuracy: 0.9, avgCostUsd: 0.002, meetsThreshold: true },
            { model: 'unknown-ctx/chat', accuracy: 0.7, avgCostUsd: 0.003, meetsThreshold: true },
          ],
        },
      };
      const caps = makeCaps({
        'small/chat': { inputModalities: [], contextLength: 4_000 },
        'medium/chat': { inputModalities: [], contextLength: 8_000 },
        'unknown-ctx/chat': { inputModalities: [], contextLength: null },
      });
      // 50k tokens is bigger than even the largest known context; the
      // unknown-context candidate keeps its rank (it is not provably too
      // small) so it wins.
      const decision = computeDecision(
        classification,
        sizedTable,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { promptTokensEstimate: 50_000 },
          capabilityMap: caps,
        }
      );
      expect(decision).toMatchObject({ model: 'unknown-ctx/chat', sticky: false });
    });

    it('falls back to the max-known-context candidate when every known context is too small AND no unknown exists', () => {
      const sizedTable: RoutingTable = {
        ...table,
        routes: {
          ...table.routes,
          'implementation/code_generation': [
            { model: 'small/chat', accuracy: 0.95, avgCostUsd: 0.001, meetsThreshold: true },
            { model: 'medium/chat', accuracy: 0.9, avgCostUsd: 0.002, meetsThreshold: true },
            { model: 'largest/chat', accuracy: 0.7, avgCostUsd: 0.003, meetsThreshold: true },
          ],
        },
      };
      const caps = makeCaps({
        'small/chat': { inputModalities: [], contextLength: 4_000 },
        'medium/chat': { inputModalities: [], contextLength: 8_000 },
        'largest/chat': { inputModalities: [], contextLength: 32_000 },
      });
      const decision = computeDecision(
        classification,
        sizedTable,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { promptTokensEstimate: 50_000 },
          capabilityMap: caps,
        }
      );
      expect(decision).toMatchObject({ model: 'largest/chat', sticky: false });
    });

    it('preserves existing ranking and sticky behaviour when all contexts are unknown', () => {
      const sizedTable: RoutingTable = {
        ...table,
        routes: {
          ...table.routes,
          'implementation/code_generation': [
            { model: 'a/chat', accuracy: 0.95, avgCostUsd: 0.001, meetsThreshold: true },
            { model: 'b/chat', accuracy: 0.9, avgCostUsd: 0.002, meetsThreshold: true },
          ],
        },
      };
      const caps = makeCaps({
        'a/chat': { inputModalities: [], contextLength: null },
        'b/chat': { inputModalities: [], contextLength: null },
      });
      const decision = computeDecision(
        classification,
        sizedTable,
        inc('b/chat'),
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { promptTokensEstimate: 50_000 },
          capabilityMap: caps,
        }
      );
      // b/chat is the incumbent but is more expensive than a/chat by less
      // than 3x, so the sticky rule keeps it.
      expect(decision).toMatchObject({ model: 'b/chat', sticky: true });
    });

    it('a fitting text-only request with only a token estimate preserves the no-constraints winner', () => {
      const caps = makeCaps({
        'cheap/chat': { inputModalities: [], contextLength: 1_000_000 },
        'mid/chat': { inputModalities: [], contextLength: 1_000_000 },
        'pricey/chat': { inputModalities: [], contextLength: 1_000_000 },
      });
      const noConstraints = computeDecision(classification, table, null);
      const withConstraints = computeDecision(
        classification,
        table,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: { promptTokensEstimate: 1_000 },
          capabilityMap: caps,
        }
      );
      expect(withConstraints?.model).toBe(noConstraints?.model);
      expect(withConstraints?.sticky).toBe(false);
    });

    it('a fitting text-only request with only a token estimate preserves the no-constraints winner in best_accuracy mode', () => {
      const caps = makeCaps({
        'pricey/chat': { inputModalities: [], contextLength: 1_000_000 },
      });
      const noConstraints = computeDecision(
        classification,
        table,
        null,
        new Set(),
        'best_accuracy'
      );
      const withConstraints = computeDecision(
        classification,
        table,
        null,
        new Set(),
        'best_accuracy',
        {
          constraints: { promptTokensEstimate: 1_000 },
          capabilityMap: caps,
        }
      );
      expect(withConstraints?.model).toBe(noConstraints?.model);
    });

    it('treats constraints with no fields set as a no-op filter (regression guarantee)', () => {
      // Spec: "if [constraints is] present with genuinely no fields set,
      // behaviour should still reduce to a no-op filter per the no-op
      // rules above".
      const noConstraints = computeDecision(classification, table, null);
      const emptyConstraints = computeDecision(
        classification,
        table,
        null,
        new Set(),
        'cost_per_accuracy',
        {
          constraints: {},
        }
      );
      expect(emptyConstraints).toEqual(noConstraints);
    });
  });

  describe('exact-pair stickiness and variant emission', () => {
    const variantTable: RoutingTable = {
      ...table,
      routes: {
        'implementation/code_generation': [
          {
            model: 'shared/chat',
            accuracy: 0.9,
            avgCostUsd: 0.002,
            meetsThreshold: true,
            variant: 'instant',
          },
          {
            model: 'shared/chat',
            accuracy: 0.85,
            avgCostUsd: 0.005,
            meetsThreshold: true,
            variant: 'thinking',
          },
          {
            model: 'other/chat',
            accuracy: 0.8,
            avgCostUsd: 0.01,
            meetsThreshold: true,
            variant: null,
          },
        ],
      },
    };

    it('keeps an exact-pair incumbent over a cheaper different variant of the same model', () => {
      const decision = computeDecision(
        classification,
        variantTable,
        inc('shared/chat', 'thinking')
      );
      expect(decision).toMatchObject({
        model: 'shared/chat',
        variant: 'thinking',
        sticky: true,
      });
      expect(decision).not.toHaveProperty('reasoningEffort');
    });

    it('switches when the exact-pair incumbent was removed from the candidate set', () => {
      const decision = computeDecision(
        classification,
        variantTable,
        inc('shared/chat', 'gone-variant')
      );
      expect(decision).toMatchObject({
        model: 'shared/chat',
        variant: 'instant',
        sticky: false,
        switchReason: 'threshold',
      });
    });

    it('legacy model-only sticky matches a single candidate with that model', () => {
      // Fresh pick is cheaper but not by more than switchCostFactor (3x), so
      // the unique model-only sticky match is kept.
      const singleVariantTable: RoutingTable = {
        ...table,
        routes: {
          'implementation/code_generation': [
            {
              model: 'fresh/chat',
              accuracy: 0.9,
              avgCostUsd: 0.002,
              meetsThreshold: true,
              variant: null,
            },
            {
              model: 'only/chat',
              accuracy: 0.85,
              avgCostUsd: 0.005,
              meetsThreshold: true,
              variant: 'max',
            },
          ],
        },
      };
      const decision = computeDecision(classification, singleVariantTable, inc('only/chat', null));
      expect(decision).toMatchObject({
        model: 'only/chat',
        variant: 'max',
        sticky: true,
      });
    });

    it('legacy model-only sticky is ignored when two variants of the model are candidates', () => {
      const decision = computeDecision(classification, variantTable, inc('shared/chat', null));
      // No unique model match → no incumbent → fresh pick
      expect(decision).toMatchObject({
        model: 'shared/chat',
        variant: 'instant',
        sticky: false,
        switchReason: null,
      });
    });

    it('emits variant without reasoningEffort for new-style candidates', () => {
      const decision = computeDecision(classification, variantTable, null);
      expect(decision).toEqual({
        model: 'shared/chat',
        taskType: 'implementation',
        subtaskType: 'code_generation',
        source: 'benchmark',
        tableVersion: 'run-1',
        variant: 'instant',
        sticky: false,
        switchReason: null,
      });
    });

    it('emits reasoningEffort without variant for legacy candidates', () => {
      const decision = computeDecision(classification, table, null, new Set(['cheap/chat']));
      expect(decision).toEqual({
        model: 'mid/chat',
        taskType: 'implementation',
        subtaskType: 'code_generation',
        source: 'benchmark',
        tableVersion: 'run-1',
        reasoningEffort: 'medium',
        sticky: false,
        switchReason: null,
      });
    });
  });

  describe('custom fail-closed on inactive', () => {
    const activeTable: RoutingTable = {
      ...table,
      routes: {
        'implementation/code_generation': [
          {
            model: 'inactive/chat',
            accuracy: 0.95,
            avgCostUsd: 0.001,
            meetsThreshold: true,
            variant: 'max',
          },
          {
            model: 'active/chat',
            accuracy: 0.85,
            avgCostUsd: 0.002,
            meetsThreshold: true,
            variant: 'max',
          },
        ],
      },
    };

    it('drops missing-row and isActive !== true candidates when failClosedOnInactive', () => {
      const caps = makeCaps({
        'inactive/chat': { inputModalities: [], isActive: false },
        'active/chat': { inputModalities: [], isActive: true },
      });
      const decision = computeDecision(
        classification,
        activeTable,
        null,
        new Set(),
        'cost_per_accuracy',
        { capabilityMap: caps, failClosedOnInactive: true }
      );
      expect(decision).toMatchObject({ model: 'active/chat', variant: 'max' });
    });

    it('returns null when every custom candidate is inactive or missing', () => {
      const caps = makeCaps({
        'inactive/chat': { inputModalities: [], isActive: false },
      });
      const decision = computeDecision(
        classification,
        activeTable,
        null,
        new Set(),
        'cost_per_accuracy',
        { capabilityMap: caps, failClosedOnInactive: true }
      );
      expect(decision).toBeNull();
    });

    it('does not drop inactive candidates on the platform path', () => {
      const caps = makeCaps({
        'inactive/chat': { inputModalities: [], isActive: false },
        'active/chat': { inputModalities: [], isActive: true },
      });
      const decision = computeDecision(
        classification,
        activeTable,
        null,
        new Set(),
        'cost_per_accuracy',
        { capabilityMap: caps }
      );
      expect(decision).toMatchObject({ model: 'inactive/chat' });
    });
  });
});
