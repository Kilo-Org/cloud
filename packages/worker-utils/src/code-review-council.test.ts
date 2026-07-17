import { describe, expect, it } from 'vitest';
import {
  COUNCIL_MIN_SPECIALISTS,
  COUNCIL_RESULT_MARKER_TAG,
  COUNCIL_SPECIALIST_PRESETS,
  computeCouncilDecision,
  councilDecisionBlocksMerge,
  decideCouncilFromManifest,
  deriveSpecialistVote,
  determineAutomatedReviewType,
  enabledSpecialists,
  formatAggregationStrategy,
  highestSeverityOf,
  isBlockingSeverity,
  isCouncilActive,
  parseCouncilResultManifest,
  presetToSpecialist,
  reconcileCouncilVotes,
  summarizeCouncilManifest,
  type SpecialistVote,
} from './code-review-council.js';
import type { CouncilResultManifest } from './code-review-council.js';
import { CodeReviewCouncilConfigSchema } from '@kilocode/db/schema-types';
import type { CodeReviewCouncilConfig } from '@kilocode/db/schema-types';

const votes = (...vs: Array<[string, SpecialistVote['vote']]>): SpecialistVote[] =>
  vs.map(([specialistId, vote]) => ({ specialistId, vote }));

// v2: a specialist's vote is DERIVED from its findings — a critical finding → block, else pass.
const crit = (path = 'a.ts') => [{ path, line: 1, severity: 'critical', rationale: 'x' }];
const nit = (path = 'a.ts') => [{ path, line: 1, severity: 'nitpick', rationale: 'x' }];

describe('severity → vote derivation (v2)', () => {
  it('isBlockingSeverity is true only for critical (case/space-insensitive)', () => {
    expect(isBlockingSeverity('critical')).toBe(true);
    expect(isBlockingSeverity(' Critical ')).toBe(true);
    expect(isBlockingSeverity('warning')).toBe(false);
    expect(isBlockingSeverity('')).toBe(false);
    expect(isBlockingSeverity(null)).toBe(false);
  });

  it('deriveSpecialistVote: block iff any finding is critical (no findings = pass)', () => {
    expect(deriveSpecialistVote([])).toBe('pass');
    expect(deriveSpecialistVote(nit())).toBe('pass');
    expect(deriveSpecialistVote([...nit(), ...crit()])).toBe('block');
  });

  it('highestSeverityOf returns the worst label present (original casing), or null', () => {
    expect(highestSeverityOf([])).toBeNull();
    expect(
      highestSeverityOf([
        { path: 'a', severity: 'warning', rationale: 'x' },
        { path: 'b', severity: 'critical', rationale: 'y' },
      ])
    ).toBe('critical');
    expect(highestSeverityOf([{ path: 'a', severity: 'nitpick', rationale: 'x' }])).toBe('nitpick');
    // Off-scale labels rank lowest but are still surfaced when nothing else is present.
    expect(highestSeverityOf([{ path: 'a', severity: 'weird', rationale: 'x' }])).toBe('weird');
  });
});

describe('computeCouncilDecision (binary)', () => {
  it('blocks on empty coverage for every enforcing strategy (never pass)', () => {
    expect(computeCouncilDecision([], 'unanimous')).toBe('block');
    expect(computeCouncilDecision([], 'majority')).toBe('block');
  });

  describe('unanimous', () => {
    it('blocks if any specialist blocks', () => {
      expect(computeCouncilDecision(votes(['a', 'pass'], ['b', 'block']), 'unanimous')).toBe(
        'block'
      );
    });
    it('passes only when every specialist passes', () => {
      expect(computeCouncilDecision(votes(['a', 'pass'], ['b', 'pass']), 'unanimous')).toBe('pass');
    });
  });

  describe('majority', () => {
    it('blocks only when block votes outnumber pass votes; ties pass', () => {
      expect(
        computeCouncilDecision(votes(['a', 'block'], ['b', 'block'], ['c', 'pass']), 'majority')
      ).toBe('block');
      // 1 block, 1 pass → tie → pass.
      expect(computeCouncilDecision(votes(['a', 'block'], ['b', 'pass']), 'majority')).toBe('pass');
    });
  });
});

describe('councilDecisionBlocksMerge', () => {
  it('blocks only on block; pass and null (advisory) do not', () => {
    expect(councilDecisionBlocksMerge('block')).toBe(true);
    expect(councilDecisionBlocksMerge('pass')).toBe(false);
    expect(councilDecisionBlocksMerge(null)).toBe(false);
  });
});

describe('parseCouncilResultManifest', () => {
  // v2 manifest: specialists report findings only (no vote/highestSeverity — code derives them).
  const manifest = {
    specialists: [
      {
        specialistId: 'security',
        findings: [{ path: 'a.ts', line: 3, severity: 'critical', rationale: 'sqli' }],
      },
      { specialistId: 'performance', findings: [] },
    ],
  };

  it('captures a well-formed combined manifest', () => {
    const text = `review done\n<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(manifest)} -->`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(capture.manifest.specialists).toHaveLength(2);
    expect(capture.manifest.specialists[0].findings).toHaveLength(1);
    // An explicit empty findings array is valid (= "reviewed, nothing blocking").
    expect(capture.manifest.specialists[1].findings).toEqual([]);
  });

  it('returns missing when no marker present', () => {
    expect(parseCouncilResultManifest('no marker here').status).toBe('missing');
    expect(parseCouncilResultManifest('').status).toBe('missing');
    expect(parseCouncilResultManifest(null).status).toBe('missing');
  });

  it('returns invalid when a specialist entry is missing its id', () => {
    const bad = { specialists: [{ findings: [] }] };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(bad)} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('fails closed: a specialist entry with NO findings key is invalid (not a silent pass)', () => {
    const bad = { specialists: [{ specialistId: 'security' }] };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(bad)} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('fails closed: an off-scale severity is invalid (a mislabeled critical cannot derive to pass)', () => {
    const bad = {
      specialists: [
        {
          specialistId: 'security',
          findings: [{ path: 'a.ts', severity: 'high', rationale: 'x' }],
        },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(bad)} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('tolerates casing/whitespace on canonical severities', () => {
    const ok = {
      specialists: [
        {
          specialistId: 'security',
          findings: [{ path: 'a.ts', severity: ' Critical ', rationale: 'x' }],
        },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(ok)} -->`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(deriveSpecialistVote(capture.manifest.specialists[0].findings)).toBe('block');
  });

  it('returns invalid on non-JSON payload', () => {
    expect(parseCouncilResultManifest(`<!-- ${COUNCIL_RESULT_MARKER_TAG} {nope} -->`).status).toBe(
      'invalid'
    );
  });

  it('uses the last marker when several are present (trailing prose safe)', () => {
    const first = { specialists: [{ specialistId: 'security', findings: [] }] };
    const last = { specialists: [{ specialistId: 'security', findings: crit() }] };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(first)} -->\nthen\n<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(last)} -->\ntrailing note`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    // The LAST marker wins — its security finding is critical (→ derived block).
    expect(deriveSpecialistVote(capture.manifest.specialists[0].findings)).toBe('block');
  });

  it('captures a manifest whose finding text contains --> and braces (no false invalid)', () => {
    const tricky = {
      specialists: [
        {
          specialistId: 'correctness',
          findings: [
            {
              path: 'src/loop.ts',
              line: 12,
              severity: 'warning',
              rationale: 'Confusing "goes to" operator: while (i --> 0) {} reads like an arrow.',
            },
          ],
        },
      ],
    };
    const text = `Summary here.\n<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(tricky)} -->\nthanks!`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(capture.manifest.specialists[0].findings[0].rationale).toContain('i --> 0');
  });

  it('captures the last marker even when an earlier finding contains -->', () => {
    const first = {
      specialists: [
        {
          specialistId: 'security',
          findings: [{ path: 'a.ts', line: 1, severity: 'nitpick', rationale: 'note --> here' }],
        },
      ],
    };
    const last = { specialists: [{ specialistId: 'security', findings: crit() }] };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(first)} -->\n<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(last)} -->`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(deriveSpecialistVote(capture.manifest.specialists[0].findings)).toBe('block');
  });

  it('treats a duplicate specialistId as invalid (a later entry cannot override an earlier one)', () => {
    const dup = {
      specialists: [
        { specialistId: 'security', findings: crit() },
        { specialistId: 'security', findings: [] },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(dup)} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
    // And a duplicate manifest must fail closed at the decision layer.
    const decision = decideCouncilFromManifest(
      ['security'],
      dup as unknown as CouncilResultManifest,
      'unanimous'
    );
    expect(decision.decision).toBe('block');
    expect(decision.missingSpecialistIds).toEqual(['security']);
  });

  it('does not treat a longer version tag (v20 / v2junk) as the marker', () => {
    const m = { specialists: [{ specialistId: 'security', findings: [] }] };
    expect(
      parseCouncilResultManifest(`<!-- ${COUNCIL_RESULT_MARKER_TAG}0 ${JSON.stringify(m)} -->`)
        .status
    ).toBe('missing');
    expect(
      parseCouncilResultManifest(`<!-- ${COUNCIL_RESULT_MARKER_TAG}junk ${JSON.stringify(m)} -->`)
        .status
    ).toBe('missing');
  });

  it('ignores marker text embedded inside a finding and captures the real manifest', () => {
    const real = {
      specialists: [
        {
          specialistId: 'security',
          findings: [
            {
              path: 'a.ts',
              line: 1,
              severity: 'critical',
              rationale: `Do not emit <!-- ${COUNCIL_RESULT_MARKER_TAG} {"specialists":[]} --> in code.`,
            },
          ],
        },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(real)} -->`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(capture.manifest.specialists).toHaveLength(1);
    expect(deriveSpecialistVote(capture.manifest.specialists[0].findings)).toBe('block');
  });

  it('a malformed LATEST top-level marker stays invalid and does not fall back to an earlier valid one', () => {
    const earlier = { specialists: [{ specialistId: 'security', findings: [] }] };
    // Later top-level marker is malformed (entry missing specialistId) — must fail closed.
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(earlier)} -->\n<!-- ${COUNCIL_RESULT_MARKER_TAG} {"specialists":[{"findings":[]}]} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('ignores many embedded marker prefixes inside a finding and captures the real manifest', () => {
    const noise = `prefix <!-- ${COUNCIL_RESULT_MARKER_TAG} `.repeat(20);
    const real = {
      specialists: [
        {
          specialistId: 'security',
          findings: [{ path: 'a.ts', line: 1, severity: 'critical', rationale: noise }],
        },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(real)} -->`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(deriveSpecialistVote(capture.manifest.specialists[0].findings)).toBe('block');
  });

  it('does not swallow unrelated JSON when the marker has no immediate payload', () => {
    const stray = JSON.stringify({ specialists: [{ specialistId: 'security', findings: [] }] });
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} -->\nHere is some JSON: ${stray}`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('requires the closing --> frame after the JSON object', () => {
    const m = { specialists: [{ specialistId: 'security', findings: [] }] };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(m)} and then prose`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('ignores an embedded marker preceded by a Unicode line separator (U+2028/U+2029)', () => {
    const real = {
      specialists: [
        {
          specialistId: 'security',
          findings: [
            {
              path: 'a.ts',
              line: 1,
              severity: 'critical',
              rationale: `line1 <!-- ${COUNCIL_RESULT_MARKER_TAG} {"specialists":[]} --> end`,
            },
          ],
        },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(real)} -->`;
    expect(text).toContain(' ');
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(deriveSpecialistVote(capture.manifest.specialists[0].findings)).toBe('block');
  });

  it('enforces the byte cap for unpaired surrogates (cannot undercount past 128 KiB)', () => {
    const seq = '\uD800ࠀ'.repeat(25_000);
    const payload = `{"specialists":[],"x":"${seq}"}`;
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${payload} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('does not treat a mid-line (non-line-anchored) marker as top-level', () => {
    const m = { specialists: [{ specialistId: 'security', findings: [] }] };
    expect(
      parseCouncilResultManifest(
        `prefix <!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(m)} -->`
      ).status
    ).toBe('missing');
  });

  it('returns invalid when the payload exceeds the size cap', () => {
    const huge = {
      specialists: [
        {
          specialistId: 'security',
          findings: [
            { path: 'a.ts', line: 1, severity: 'warning', rationale: 'y'.repeat(200_000) },
          ],
        },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(huge)} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });
});

describe('summarizeCouncilManifest', () => {
  it('derives vote + highest severity from findings (model reports neither)', () => {
    const summary = summarizeCouncilManifest({
      specialists: [
        {
          specialistId: 'security',
          findings: [
            { path: 'a.ts', line: 1, severity: 'critical', rationale: 'x' },
            { path: 'b.ts', line: 2, severity: 'warning', rationale: 'y' },
          ],
        },
        { specialistId: 'performance', findings: [] },
      ],
    });
    expect(summary).toEqual([
      { specialistId: 'security', vote: 'block', highestSeverity: 'critical', findingsCount: 2 },
      { specialistId: 'performance', vote: 'pass', highestSeverity: null, findingsCount: 0 },
    ]);
  });
});

describe('reconcileCouncilVotes', () => {
  const manifest: CouncilResultManifest = {
    specialists: [
      { specialistId: 'security', findings: crit() },
      { specialistId: 'unknown', findings: [] },
    ],
  };

  it('surfaces a configured specialist absent from the manifest as missing', () => {
    const coverage = reconcileCouncilVotes(['security', 'performance'], manifest);
    expect(coverage.votes).toEqual([{ specialistId: 'security', vote: 'block' }]);
    expect(coverage.missingSpecialistIds).toEqual(['performance']);
  });

  it('ignores manifest entries for specialists we did not configure', () => {
    const coverage = reconcileCouncilVotes(['security'], manifest);
    expect(coverage.votes).toEqual([{ specialistId: 'security', vote: 'block' }]);
    expect(coverage.missingSpecialistIds).toEqual([]);
  });

  it('derives pass for a reported specialist with no critical findings', () => {
    const coverage = reconcileCouncilVotes(['security'], {
      specialists: [{ specialistId: 'security', findings: nit() }],
    });
    expect(coverage.votes).toEqual([{ specialistId: 'security', vote: 'pass' }]);
  });
});

describe('decideCouncilFromManifest (coverage-aware)', () => {
  it('advisory: computes NO aggregate decision (null), regardless of votes', () => {
    const manifest: CouncilResultManifest = {
      specialists: [{ specialistId: 'security', findings: crit() }],
    };
    const result = decideCouncilFromManifest(['security'], manifest, 'advisory');
    expect(result.decision).toBeNull();
    expect(result.votes).toEqual([{ specialistId: 'security', vote: 'block' }]);
  });

  it('blocks under enforcing strategies when a configured specialist is missing (fail closed)', () => {
    const manifest: CouncilResultManifest = {
      specialists: [{ specialistId: 'security', findings: [] }],
    };
    for (const strategy of ['unanimous', 'majority'] as const) {
      const result = decideCouncilFromManifest(['security', 'performance'], manifest, strategy);
      expect(result.decision).toBe('block');
      expect(result.missingSpecialistIds).toEqual(['performance']);
    }
  });

  it('passes when every configured specialist reported and none is critical', () => {
    const manifest: CouncilResultManifest = {
      specialists: [
        { specialistId: 'security', findings: [] },
        { specialistId: 'performance', findings: nit() },
      ],
    };
    const result = decideCouncilFromManifest(['security', 'performance'], manifest, 'unanimous');
    expect(result.decision).toBe('pass');
    expect(result.missingSpecialistIds).toEqual([]);
  });

  it('blocks under unanimous when one specialist has a critical finding', () => {
    const manifest: CouncilResultManifest = {
      specialists: [
        { specialistId: 'security', findings: crit() },
        { specialistId: 'performance', findings: [] },
      ],
    };
    const result = decideCouncilFromManifest(['security', 'performance'], manifest, 'unanimous');
    expect(result.decision).toBe('block');
  });

  it('fails closed on a duplicate configured id (a specialist cannot be counted twice)', () => {
    const manifest: CouncilResultManifest = {
      specialists: [{ specialistId: 'security', findings: [] }],
    };
    const result = decideCouncilFromManifest(['security', 'security'], manifest, 'majority');
    expect(result.decision).toBe('block');
    expect(result.missingSpecialistIds).toEqual(['security']);
    expect(result.votes).toEqual([]);
  });
});

describe('council config helpers', () => {
  const council: CodeReviewCouncilConfig = {
    enabled: true,
    aggregation_strategy: 'unanimous',
    specialists: [
      presetToSpecialist(COUNCIL_SPECIALIST_PRESETS[0]),
      { ...presetToSpecialist(COUNCIL_SPECIALIST_PRESETS[1]), enabled: false },
    ],
  };
  const activeCouncil: CodeReviewCouncilConfig = {
    enabled: true,
    aggregation_strategy: 'advisory',
    specialists: [
      presetToSpecialist(COUNCIL_SPECIALIST_PRESETS[0]),
      presetToSpecialist(COUNCIL_SPECIALIST_PRESETS[1]),
    ],
  };

  it('enabledSpecialists filters to enabled', () => {
    expect(enabledSpecialists(council).map(s => s.id)).toEqual(['security']);
  });

  it('isCouncilActive requires enabled + at least COUNCIL_MIN_SPECIALISTS enabled specialists', () => {
    expect(isCouncilActive(activeCouncil)).toBe(true);
    expect(isCouncilActive(council)).toBe(false);
    expect(isCouncilActive({ ...activeCouncil, enabled: false })).toBe(false);
    expect(isCouncilActive({ ...activeCouncil, specialists: [] })).toBe(false);
    expect(isCouncilActive(null)).toBe(false);
  });

  it('formatAggregationStrategy labels the governance modes and falls back', () => {
    expect(formatAggregationStrategy('majority')).toBe('Majority');
    expect(formatAggregationStrategy('unanimous')).toBe('Unanimous');
    expect(formatAggregationStrategy(null)).toBe('Advisory (report only)');
    expect(formatAggregationStrategy('weird')).toBe('weird');
  });

  it('normalizes legacy v1 aggregation_strategy values when parsing a persisted config', () => {
    const base = {
      enabled: true,
      specialists: [presetToSpecialist(COUNCIL_SPECIALIST_PRESETS[0])],
    };
    // Pre-v2 configs used any_blocking_member / unanimous_required — both → v2 unanimous.
    expect(
      CodeReviewCouncilConfigSchema.parse({ ...base, aggregation_strategy: 'any_blocking_member' })
        .aggregation_strategy
    ).toBe('unanimous');
    expect(
      CodeReviewCouncilConfigSchema.parse({ ...base, aggregation_strategy: 'unanimous_required' })
        .aggregation_strategy
    ).toBe('unanimous');
    // New values + omitted (→ default advisory) pass through.
    expect(
      CodeReviewCouncilConfigSchema.parse({ ...base, aggregation_strategy: 'majority' })
        .aggregation_strategy
    ).toBe('majority');
    expect(CodeReviewCouncilConfigSchema.parse(base).aggregation_strategy).toBe('advisory');
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
