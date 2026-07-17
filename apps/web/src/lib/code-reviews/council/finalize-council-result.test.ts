import { describe, expect, it } from '@jest/globals';
import { COUNCIL_RESULT_MARKER_TAG } from '@kilocode/worker-utils/code-review-council';
import type { CodeReviewCouncilConfig } from '@kilocode/db/schema-types';
import { buildCouncilResult } from './finalize-council-result';

const council: CodeReviewCouncilConfig = {
  enabled: true,
  aggregation_strategy: 'unanimous',
  specialists: [
    {
      id: 'security',
      role: 'security',
      name: 'Security',
      enabled: true,
      required: false,
      lens: 'security',
      model_slug: 'anthropic/x',
    },
    {
      id: 'performance',
      role: 'performance',
      name: 'Performance',
      enabled: true,
      required: false,
      lens: 'performance',
    },
  ],
};

// v2: specialists report findings only (no vote). The vote is derived: a critical finding → block.
const crit = [{ path: 'a.ts', line: 3, severity: 'critical', rationale: 'sqli' }];

const manifestText = (specialists: unknown[]): string =>
  `done\n<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify({ specialists })} -->`;

describe('buildCouncilResult', () => {
  it('derives each specialist vote + highest severity from findings; decision from votes', () => {
    const result = buildCouncilResult({
      council,
      baseModel: 'base/model',
      baseThinkingEffort: null,
      lastAssistantMessageText: manifestText([
        { specialistId: 'security', findings: crit },
        { specialistId: 'performance', findings: [] },
      ]),
    });

    expect(result.decision).toBe('block'); // unanimous + one critical (derived block)
    expect(result.aggregationStrategy).toBe('unanimous');
    expect(result.specialists[0]).toMatchObject({
      id: 'security',
      model: 'anthropic/x',
      vote: 'block',
      highestSeverity: 'critical',
    });
    expect(result.specialists[0].findings).toHaveLength(1);
    // performance: no findings → derived pass; model falls back to the review base model.
    expect(result.specialists[1]).toMatchObject({
      id: 'performance',
      model: 'base/model',
      vote: 'pass',
      highestSeverity: null,
    });
  });

  it('passes under unanimous when every specialist has no critical finding', () => {
    const result = buildCouncilResult({
      council,
      baseModel: 'base/model',
      baseThinkingEffort: null,
      lastAssistantMessageText: manifestText([
        {
          specialistId: 'security',
          findings: [{ path: 'a', severity: 'warning', rationale: 'x' }],
        },
        { specialistId: 'performance', findings: [] },
      ]),
    });
    expect(result.decision).toBe('pass');
    expect(result.specialists.every(s => s.vote === 'pass')).toBe(true);
  });

  it('advisory: computes NO decision (null) but still derives per-specialist votes', () => {
    const result = buildCouncilResult({
      council: { ...council, aggregation_strategy: 'advisory' },
      baseModel: 'base/model',
      baseThinkingEffort: null,
      lastAssistantMessageText: manifestText([
        { specialistId: 'security', findings: crit },
        { specialistId: 'performance', findings: [] },
      ]),
    });
    expect(result.decision).toBeNull();
    expect(result.aggregationStrategy).toBe('advisory');
    expect(result.specialists.find(s => s.id === 'security')?.vote).toBe('block');
    expect(result.specialists.find(s => s.id === 'performance')?.vote).toBe('pass');
  });

  it('prefers the model the specialist REPORTED (auto slug resolved) over the configured model', () => {
    const result = buildCouncilResult({
      council,
      baseModel: 'base/model',
      baseThinkingEffort: null,
      lastAssistantMessageText: manifestText([
        { specialistId: 'security', model: 'anthropic/claude-sonnet-5', findings: [] },
        { specialistId: 'performance', model: 'openai/gpt-5', findings: [] },
      ]),
    });
    expect(result.specialists.find(s => s.id === 'security')?.model).toBe(
      'anthropic/claude-sonnet-5'
    );
    expect(result.specialists.find(s => s.id === 'performance')?.model).toBe('openai/gpt-5');
  });

  it('falls back to the configured/base model when the specialist reports no model', () => {
    const result = buildCouncilResult({
      council,
      baseModel: 'base/model',
      baseThinkingEffort: null,
      lastAssistantMessageText: manifestText([
        { specialistId: 'security', findings: [] },
        { specialistId: 'performance', findings: [] },
      ]),
    });
    expect(result.specialists.find(s => s.id === 'security')?.model).toBe('anthropic/x');
    expect(result.specialists.find(s => s.id === 'performance')?.model).toBe('base/model');
  });

  it('only inherits base thinking effort when the specialist also inherits the base model', () => {
    const result = buildCouncilResult({
      council,
      baseModel: 'base/model',
      baseThinkingEffort: 'high',
      lastAssistantMessageText: manifestText([
        { specialistId: 'security', findings: [] },
        { specialistId: 'performance', findings: [] },
      ]),
    });
    // security has its OWN model (anthropic/x) → does NOT inherit the base effort.
    expect(result.specialists.find(s => s.id === 'security')).toMatchObject({
      model: 'anthropic/x',
      thinkingEffort: null,
    });
    // performance inherits the default model → inherits the base effort.
    expect(result.specialists.find(s => s.id === 'performance')).toMatchObject({
      model: 'base/model',
      thinkingEffort: 'high',
    });
  });

  it('fails closed (block) when a configured specialist is missing from the manifest', () => {
    const result = buildCouncilResult({
      council,
      baseModel: 'base/model',
      baseThinkingEffort: null,
      lastAssistantMessageText: manifestText([{ specialistId: 'security', findings: [] }]),
    });
    expect(result.decision).toBe('block'); // missing performance → no coverage → block
    // The missing specialist shows "no result" (vote null), NOT a block vote.
    const performance = result.specialists.find(s => s.id === 'performance');
    expect(performance).toMatchObject({ vote: null, highestSeverity: null });
    expect(performance?.findings).toEqual([]);
  });

  it('fails closed (block) when no manifest is present; specialists show "no result"', () => {
    const result = buildCouncilResult({
      council,
      baseModel: 'base/model',
      baseThinkingEffort: null,
      lastAssistantMessageText: 'no marker here',
    });
    expect(result.decision).toBe('block');
    // No specialist reported → all "no result" (vote null), none shown as a block vote.
    expect(result.specialists.every(s => s.vote === null)).toBe(true);
  });

  it('fails closed on an invalid manifest payload; specialists show "no result"', () => {
    const result = buildCouncilResult({
      council,
      baseModel: null,
      baseThinkingEffort: null,
      lastAssistantMessageText: `<!-- ${COUNCIL_RESULT_MARKER_TAG} {not json} -->`,
    });
    expect(result.decision).toBe('block');
    expect(result.specialists.every(s => s.vote === null)).toBe(true);
  });
});
