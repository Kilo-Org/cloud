import { describe, expect, it } from 'vitest';
import { classifierTaxonomy } from '@kilocode/auto-routing-contracts/classifier';
import type { DeciderCase } from '../decider-cases';
import { FRONTIER_LONG_CONTEXT_CASES, LONG_CONTEXT_CASES } from './cases';
import { LONG_CONTEXT_GENERATORS } from './generators';
import { seededRandom } from './generators/common';
import { materializeLongContext } from './index';

const ALL_CASES = [...LONG_CONTEXT_CASES, ...FRONTIER_LONG_CONTEXT_CASES];
const EXPECTED_ROUTES = classifierTaxonomy.taskTypes
  .filter(task => ['implementation', 'debugging', 'investigation', 'refactoring'].includes(task.id))
  .flatMap(task => task.subtypes.map(subtype => `${task.id}/${subtype.id}`));

describe('long-context cases', () => {
  it('covers each supported taxonomy route at both tiers without overlapping ids', () => {
    expect(EXPECTED_ROUTES).toHaveLength(12);
    expect(LONG_CONTEXT_CASES).toHaveLength(36);
    expect(FRONTIER_LONG_CONTEXT_CASES).toHaveLength(24);
    expect(new Set(ALL_CASES.map(c => c.id)).size).toBe(ALL_CASES.length);
    for (const route of EXPECTED_ROUTES) {
      expect(LONG_CONTEXT_CASES.filter(c => `${c.taskType}/${c.subtaskType}` === route), route).toHaveLength(3);
      expect(FRONTIER_LONG_CONTEXT_CASES.filter(c => `${c.taskType}/${c.subtaskType}` === route), route).toHaveLength(2);
    }
    expect(LONG_CONTEXT_CASES.every(c => c.tier === 'efficient')).toBe(true);
    expect(FRONTIER_LONG_CONTEXT_CASES.every(c => c.tier === 'frontier')).toBe(true);
  });

  it('has one 32k, 96k and 160k efficient case per route and only 160k frontier cases', () => {
    for (const route of EXPECTED_ROUTES) {
      const targets = LONG_CONTEXT_CASES
        .filter(c => `${c.taskType}/${c.subtaskType}` === route)
        .map(c => c.longContext?.targetTokens);
      expect(targets, route).toEqual([32000, 96000, 160000]);
    }
    expect(FRONTIER_LONG_CONTEXT_CASES.every(c => c.longContext?.targetTokens === 160000)).toBe(true);
  });

  it.each(ALL_CASES.map(c => [c.id, c] as const))('%s is deterministic, sized and mechanically graded', (_id, c) => {
    const config = c.longContext;
    if (!config) throw new Error(`Missing longContext: ${c.id}`);
    const first = materializeLongContext(c);
    expect(materializeLongContext(c)).toEqual(first);
    const estimatedTokens = (first.systemPrompt.length + first.userPrompt.length) / 4;
    expect(estimatedTokens).toBeGreaterThanOrEqual(config.targetTokens * 0.85);
    expect(estimatedTokens).toBeLessThanOrEqual(config.targetTokens * 1.15);
    expect(first.userPrompt.endsWith(c.userPrompt)).toBe(true);
    expect(c.userPrompt.length).toBeLessThan(2500);
    expect(first.systemPrompt).toContain('historical messages');
    expect(first.userPrompt).not.toContain(JSON.stringify(c.check.kind === 'json_equal' ? c.check.value : null));
    expect(c.check.kind).toBe('json_equal');
    const generator = Object.entries(LONG_CONTEXT_GENERATORS).find(([name]) => name === config.generator)?.[1];
    if (!generator) throw new Error(`Unknown generator: ${config.generator}`);
    const scenario = generator.scenario(config.seed);
    if (c.check.kind !== 'json_equal') throw new Error(`Non-mechanical check: ${c.id}`);
    expect(c.check.value).toEqual(scenario.answer);
    expect(c.userPrompt).toContain(scenario.question);
    let previousEnd = 0;
    for (const section of scenario.sections) {
      const position = first.userPrompt.indexOf(section, previousEnd);
      expect(position).toBeGreaterThan(previousEnd);
      expect(position - previousEnd).toBeGreaterThan(config.targetTokens * 4 * 0.02);
      previousEnd = position + section.length;
    }
  });

  it.each(Object.entries(LONG_CONTEXT_GENERATORS))('%s varies with the seed', (_name, generator) => {
    const first = generator.scenario(41001);
    expect(generator.scenario(41001)).toEqual(first);
    expect(generator.scenario(41002).sections).not.toEqual(first.sections);
    expect(generator.scenario(41002).answer).not.toEqual(first.answer);
  });

  it('pins reference answers reconstructed from the emitted evidence', () => {
    const references: Record<string, Record<string, string | number>> = {
      'repo-v1': {
        entrypoint: 'src/cli.ts', actual: -4, corrected: 52,
        faultyFile: 'src/pipelines/v2/stage-1.ts',
      },
      'repo-frontier-v1': {
        entrypoint: 'src/cli.ts', actual: 5037, corrected: 6829,
        faultyFile: 'src/pipelines/v2/stage-1.ts',
      },
      'transcript-v1': {
        artifact: 'export-6515-reconciled.ndjson', region: 'us-west',
        batchSize: 16, acceptedRows: 225, pages: 15,
      },
      'transcript-frontier-v1': {
        artifact: 'export-6515-reconciled.ndjson', region: 'ap-south',
        batchSize: 22, acceptedRows: 347, pages: 16,
      },
      'logs-v1': {
        deployment: 'release-215', timeoutMs: 7000, attempts: 3, elapsedMs: 225,
        rootCause: 'src/http/config.ts:seconds-used-as-milliseconds',
      },
      'logs-frontier-v1': {
        deployment: 'release-215', timeoutMs: 4000, attempts: 5, elapsedMs: 581,
        rootCause: 'src/http/config.ts:seconds-used-as-milliseconds',
      },
    };
    for (const [name, generator] of Object.entries(LONG_CONTEXT_GENERATORS)) {
      expect(generator.scenario(41001).answer, name).toEqual(references[name]);
    }
  });

  it('uses reproducible PRNG streams including zero and negative seeds', () => {
    for (const seed of [0, 1, -42, 0x7fffffff]) {
      const first = seededRandom(seed);
      const second = seededRandom(seed);
      const values = Array.from({ length: 50 }, () => first(1000));
      expect(values).toEqual(Array.from({ length: 50 }, () => second(1000)));
      expect(new Set(values).size).toBeGreaterThan(1);
      expect(values.every(value => Number.isInteger(value) && value >= 0 && value < 1000)).toBe(true);
    }
  });

  it('leaves ordinary cases unchanged and rejects unregistered generators', () => {
    const ordinary: DeciderCase = {
      id: 'ordinary',
      taskType: 'implementation',
      subtaskType: 'test_creation',
      systemPrompt: 'Return JSON.',
      userPrompt: 'Return {}.',
      check: { kind: 'json_equal', value: {} },
    };
    expect(materializeLongContext(ordinary)).toEqual({ systemPrompt: ordinary.systemPrompt, userPrompt: ordinary.userPrompt });
    expect(() => materializeLongContext({ ...ordinary, longContext: { generator: 'missing', seed: 1, targetTokens: 32000 } })).toThrow('Unknown long-context generator');
    expect(() => materializeLongContext({ ...ordinary, longContext: { generator: 'repo-v1', seed: 1, targetTokens: 0 } })).toThrow('positive integer');
    expect(() => materializeLongContext({ ...ordinary, longContext: { generator: 'repo-v1', seed: 1, targetTokens: 1 } })).toThrow('smaller than its task evidence');
  });
});
