import { describe, expect, it } from 'vitest';
import {
  COUNCIL_MIN_SPECIALISTS,
  COUNCIL_RESULT_MARKER_TAG,
  COUNCIL_SPECIALIST_PRESETS,
  computeCouncilDecision,
  councilDecisionBlocksMerge,
  describeAggregationStrategy,
  determineAutomatedReviewType,
  enabledSpecialists,
  formatAggregationStrategy,
  isCouncilActive,
  parseCouncilResultManifest,
  parseGovernanceMarker,
  presetToSpecialist,
  reconcileCouncilVotes,
  summarizeCouncilManifest,
  type SpecialistVote,
} from './code-review-council.js';
import type {
  CodeReviewCouncilConfig,
  CouncilAggregationStrategy,
} from '@kilocode/db/schema-types';

const votes = (...vs: Array<[string, SpecialistVote['vote']]>): SpecialistVote[] =>
  vs.map(([specialistId, vote]) => ({ specialistId, vote }));

describe('computeCouncilDecision', () => {
  it('blocks on empty coverage for every strategy (never pass)', () => {
    const strategies: CouncilAggregationStrategy[] = [
      'any_blocking_member',
      'majority',
      'unanimous_required',
    ];
    for (const strategy of strategies) {
      expect(computeCouncilDecision([], strategy)).toBe('block');
      // All-abstain is also "no usable coverage".
      expect(computeCouncilDecision(votes(['a', 'abstain'], ['b', 'abstain']), strategy)).toBe(
        'block'
      );
    }
  });

  describe('any_blocking_member', () => {
    it('blocks if any specialist blocks', () => {
      expect(
        computeCouncilDecision(votes(['a', 'pass'], ['b', 'block']), 'any_blocking_member')
      ).toBe('block');
    });
    it('warns if any warn and none block', () => {
      expect(
        computeCouncilDecision(votes(['a', 'pass'], ['b', 'warn']), 'any_blocking_member')
      ).toBe('warn');
    });
    it('passes when all pass', () => {
      expect(
        computeCouncilDecision(votes(['a', 'pass'], ['b', 'pass']), 'any_blocking_member')
      ).toBe('pass');
    });
  });

  describe('majority', () => {
    it('blocks only when block votes outnumber pass votes', () => {
      expect(
        computeCouncilDecision(votes(['a', 'block'], ['b', 'block'], ['c', 'pass']), 'majority')
      ).toBe('block');
      // Tie (1 block, 1 pass) is not a block majority → warn/pass by remaining votes.
      expect(computeCouncilDecision(votes(['a', 'block'], ['b', 'pass']), 'majority')).toBe('pass');
    });
    it('warns when not out-blocked but a warn exists', () => {
      expect(
        computeCouncilDecision(votes(['a', 'pass'], ['b', 'pass'], ['c', 'warn']), 'majority')
      ).toBe('warn');
    });
  });

  describe('unanimous_required', () => {
    it('blocks if any block or abstain', () => {
      expect(
        computeCouncilDecision(votes(['a', 'pass'], ['b', 'abstain']), 'unanimous_required')
      ).toBe('block');
      expect(
        computeCouncilDecision(votes(['a', 'pass'], ['b', 'block']), 'unanimous_required')
      ).toBe('block');
    });
    it('warns if all non-block/non-abstain but a warn exists', () => {
      expect(
        computeCouncilDecision(votes(['a', 'pass'], ['b', 'warn']), 'unanimous_required')
      ).toBe('warn');
    });
    it('passes only when every specialist passes', () => {
      expect(
        computeCouncilDecision(votes(['a', 'pass'], ['b', 'pass']), 'unanimous_required')
      ).toBe('pass');
    });
  });
});

describe('councilDecisionBlocksMerge', () => {
  it('blocks only on block', () => {
    expect(councilDecisionBlocksMerge('block')).toBe(true);
    expect(councilDecisionBlocksMerge('warn')).toBe(false);
    expect(councilDecisionBlocksMerge('pass')).toBe(false);
    expect(councilDecisionBlocksMerge('abstain')).toBe(false);
  });
});

describe('describeAggregationStrategy', () => {
  it('returns distinct wording per strategy', () => {
    const a = describeAggregationStrategy('any_blocking_member');
    const m = describeAggregationStrategy('majority');
    const u = describeAggregationStrategy('unanimous_required');
    expect(new Set([a, m, u]).size).toBe(3);
    expect(m.toLowerCase()).toContain('majority');
    expect(u.toLowerCase()).toContain('unanimous');
  });
});

describe('parseCouncilResultManifest', () => {
  const manifest = {
    specialists: [
      {
        specialistId: 'security',
        vote: 'block',
        highestSeverity: 'critical',
        findings: [{ path: 'a.ts', line: 3, severity: 'critical', rationale: 'sqli' }],
      },
      { specialistId: 'performance', vote: 'pass', findings: [] },
    ],
  };

  it('captures a well-formed combined manifest', () => {
    const text = `review done\n<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(manifest)} -->`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(capture.manifest.specialists).toHaveLength(2);
    expect(capture.manifest.specialists[0].findings).toHaveLength(1);
    // findings defaults to [] when omitted.
    expect(capture.manifest.specialists[1].findings).toEqual([]);
  });

  it('returns missing when no marker present', () => {
    expect(parseCouncilResultManifest('no marker here').status).toBe('missing');
    expect(parseCouncilResultManifest('').status).toBe('missing');
    expect(parseCouncilResultManifest(null).status).toBe('missing');
  });

  it('returns invalid when a specialist vote is missing/invalid', () => {
    const bad = { specialists: [{ specialistId: 'security', findings: [] }] };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(bad)} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('returns invalid on non-JSON payload', () => {
    expect(parseCouncilResultManifest(`<!-- ${COUNCIL_RESULT_MARKER_TAG} {nope} -->`).status).toBe(
      'invalid'
    );
  });

  it('uses the last marker when several are present (trailing prose safe)', () => {
    const first = { specialists: [{ specialistId: 'security', vote: 'pass', findings: [] }] };
    const last = { specialists: [{ specialistId: 'security', vote: 'block', findings: [] }] };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(first)} -->\nthen\n<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(last)} -->\ntrailing note`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(capture.manifest.specialists[0].vote).toBe('block');
  });

  it('returns invalid when the payload exceeds the size cap', () => {
    const huge = {
      specialists: [
        {
          specialistId: 'security',
          vote: 'pass',
          findings: [{ path: 'a.ts', line: 1, severity: 'x', rationale: 'y'.repeat(200_000) }],
        },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(huge)} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });
});

describe('summarizeCouncilManifest', () => {
  it('rolls up vote, highest severity, and findings count per specialist', () => {
    const summary = summarizeCouncilManifest({
      specialists: [
        {
          specialistId: 'security',
          vote: 'block',
          highestSeverity: 'critical',
          findings: [
            { path: 'a.ts', line: 1, severity: 'critical', rationale: 'x' },
            { path: 'b.ts', line: 2, severity: 'high', rationale: 'y' },
          ],
        },
        { specialistId: 'performance', vote: 'pass', findings: [] },
      ],
    });
    expect(summary).toEqual([
      { specialistId: 'security', vote: 'block', highestSeverity: 'critical', findingsCount: 2 },
      { specialistId: 'performance', vote: 'pass', highestSeverity: null, findingsCount: 0 },
    ]);
  });
});

describe('reconcileCouncilVotes', () => {
  const manifest = {
    specialists: [
      { specialistId: 'security', vote: 'block' as const, findings: [] },
      { specialistId: 'unknown', vote: 'pass' as const, findings: [] },
    ],
  };

  it('maps a configured specialist absent from the manifest to abstain', () => {
    const reconciled = reconcileCouncilVotes(['security', 'performance'], manifest);
    expect(reconciled).toEqual([
      { specialistId: 'security', vote: 'block' },
      { specialistId: 'performance', vote: 'abstain' },
    ]);
  });

  it('ignores manifest entries for specialists we did not configure', () => {
    const reconciled = reconcileCouncilVotes(['security'], manifest);
    expect(reconciled).toEqual([{ specialistId: 'security', vote: 'block' }]);
  });

  it('a dropped specialist cannot let the council pass', () => {
    const reconciled = reconcileCouncilVotes(['security', 'performance'], {
      specialists: [{ specialistId: 'security', vote: 'pass', findings: [] }],
    });
    expect(computeCouncilDecision(reconciled, 'unanimous_required')).toBe('block');
  });
});

describe('parseGovernanceMarker', () => {
  it('parses a valid governance marker', () => {
    const gov = { members: [{ id: 'security', vote: 'pass' }], decision: 'pass' };
    expect(
      parseGovernanceMarker(`<!-- kilo-review-governance:v1 ${JSON.stringify(gov)} -->`)
    ).toEqual({
      members: [{ id: 'security', vote: 'pass', highestSeverity: null }],
      decision: 'pass',
    });
  });

  it('returns null when absent or malformed', () => {
    expect(parseGovernanceMarker('nothing')).toBeNull();
    expect(parseGovernanceMarker(null)).toBeNull();
    expect(parseGovernanceMarker('<!-- kilo-review-governance:v1 {bad} -->')).toBeNull();
  });

  it('normalizes a "none" severity label to null', () => {
    const gov = { members: [{ id: 'a', vote: 'pass', highestSeverity: 'none' }], decision: 'pass' };
    const parsed = parseGovernanceMarker(
      `<!-- kilo-review-governance:v1 ${JSON.stringify(gov)} -->`
    );
    expect(parsed?.members[0].highestSeverity).toBeNull();
  });
});

describe('council config helpers', () => {
  const council: CodeReviewCouncilConfig = {
    enabled: true,
    aggregation_strategy: 'any_blocking_member',
    specialists: [
      presetToSpecialist(COUNCIL_SPECIALIST_PRESETS[0]),
      { ...presetToSpecialist(COUNCIL_SPECIALIST_PRESETS[1]), enabled: false },
    ],
  };

  it('enabledSpecialists filters to enabled', () => {
    expect(enabledSpecialists(council).map(s => s.id)).toEqual(['security']);
  });

  it('isCouncilActive requires enabled + at least one enabled specialist', () => {
    expect(isCouncilActive(council)).toBe(true);
    expect(isCouncilActive({ ...council, enabled: false })).toBe(false);
    expect(isCouncilActive({ ...council, specialists: [] })).toBe(false);
    expect(isCouncilActive(null)).toBe(false);
  });

  it('formatAggregationStrategy labels known strategies and falls back', () => {
    expect(formatAggregationStrategy('majority')).toBe('Majority');
    expect(formatAggregationStrategy(null)).toBe('Any blocking member');
    expect(formatAggregationStrategy('weird')).toBe('weird');
  });
});

describe('presets', () => {
  it('exposes at least the minimum selectable specialists with unique ids', () => {
    expect(COUNCIL_SPECIALIST_PRESETS.length).toBeGreaterThanOrEqual(COUNCIL_MIN_SPECIALISTS);
    const ids = COUNCIL_SPECIALIST_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('presetToSpecialist yields an enabled, non-required voting member', () => {
    const specialist = presetToSpecialist(COUNCIL_SPECIALIST_PRESETS[0]);
    expect(specialist).toMatchObject({ id: 'security', enabled: true, required: false });
  });
});

describe('determineAutomatedReviewType', () => {
  it('is a safe stub that always returns standard', () => {
    expect(determineAutomatedReviewType({}, { councilAvailable: true })).toBe('standard');
    expect(
      determineAutomatedReviewType(
        { isDraft: false, labels: ['council'], changedFileCount: 40 },
        { councilAvailable: true }
      )
    ).toBe('standard');
  });
});
