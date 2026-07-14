import { describe, expect, it } from '@jest/globals';
import { COUNCIL_RESULT_MARKER_TAG } from '@kilocode/worker-utils/code-review-council';
import type { CodeReviewCouncilConfig } from '@kilocode/db/schema-types';
import { buildCouncilResult } from './finalize-council-result';

const council: CodeReviewCouncilConfig = {
  enabled: true,
  aggregation_strategy: 'any_blocking_member',
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

const manifestText = (specialists: unknown[]): string =>
  `done\n<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify({ specialists })} -->`;

describe('buildCouncilResult', () => {
  it('joins each specialist with its reported vote/findings and per-specialist model', () => {
    const result = buildCouncilResult({
      council,
      baseModel: 'base/model',
      lastAssistantMessageText: manifestText([
        {
          specialistId: 'security',
          vote: 'block',
          highestSeverity: 'critical',
          findings: [{ path: 'a.ts', line: 3, severity: 'critical', rationale: 'sqli' }],
        },
        { specialistId: 'performance', vote: 'pass', findings: [] },
      ]),
    });

    expect(result.decision).toBe('block'); // any_blocking_member + a block vote
    expect(result.aggregationStrategy).toBe('any_blocking_member');
    expect(result.specialists[0]).toMatchObject({
      id: 'security',
      model: 'anthropic/x',
      vote: 'block',
      highestSeverity: 'critical',
    });
    expect(result.specialists[0].findings).toHaveLength(1);
    // Falls back to the review base model when the specialist has no model of its own.
    expect(result.specialists[1]).toMatchObject({
      id: 'performance',
      model: 'base/model',
      vote: 'pass',
    });
  });

  it('fails closed when a configured specialist is missing from the manifest', () => {
    const result = buildCouncilResult({
      council,
      baseModel: 'base/model',
      lastAssistantMessageText: manifestText([
        { specialistId: 'security', vote: 'pass', findings: [] },
      ]),
    });

    expect(result.decision).toBe('block'); // missing performance → no coverage → block
    const performance = result.specialists.find(s => s.id === 'performance');
    expect(performance).toMatchObject({ vote: 'abstain', highestSeverity: null });
    expect(performance?.findings).toEqual([]);
  });

  it('fails closed (block, all abstain) when no manifest is present', () => {
    const result = buildCouncilResult({
      council,
      baseModel: 'base/model',
      lastAssistantMessageText: 'no marker here',
    });

    expect(result.decision).toBe('block');
    expect(result.specialists.every(s => s.vote === 'abstain')).toBe(true);
  });

  it('fails closed on an invalid manifest payload', () => {
    const result = buildCouncilResult({
      council,
      baseModel: null,
      lastAssistantMessageText: `<!-- ${COUNCIL_RESULT_MARKER_TAG} {not json} -->`,
    });
    expect(result.decision).toBe('block');
    expect(result.specialists.every(s => s.vote === 'abstain')).toBe(true);
  });
});
