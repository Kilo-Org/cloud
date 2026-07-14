import { describe, expect, it } from 'vitest';
import {
  COUNCIL_MIN_SPECIALISTS,
  COUNCIL_RESULT_MARKER_TAG,
  COUNCIL_SPECIALIST_PRESETS,
  computeCouncilDecision,
  councilDecisionBlocksMerge,
  decideCouncilFromManifest,
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
import type { CouncilResultManifest } from './code-review-council.js';
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

  it('documents the no-usable-coverage → block rule for every strategy (lockstep with computeCouncilDecision)', () => {
    const strategies = ['any_blocking_member', 'majority', 'unanimous_required'] as const;
    for (const strategy of strategies) {
      const text = describeAggregationStrategy(strategy).toLowerCase();
      expect(text).toContain('all abstained');
      expect(text).toContain('block');
    }
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

  it('captures a manifest whose finding text contains --> and braces (no false invalid)', () => {
    const tricky = {
      specialists: [
        {
          specialistId: 'correctness',
          vote: 'warn',
          highestSeverity: 'medium',
          findings: [
            {
              path: 'src/loop.ts',
              line: 12,
              severity: 'medium',
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
          vote: 'pass',
          findings: [{ path: 'a.ts', line: 1, severity: 'low', rationale: 'note --> here' }],
        },
      ],
    };
    const last = {
      specialists: [{ specialistId: 'security', vote: 'block', findings: [] }],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(first)} -->\n<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(last)} -->`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(capture.manifest.specialists[0].vote).toBe('block');
  });

  it('treats a duplicate specialistId as invalid (a later entry cannot override an earlier vote)', () => {
    const dup = {
      specialists: [
        { specialistId: 'security', vote: 'block', findings: [] },
        { specialistId: 'security', vote: 'pass', findings: [] },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(dup)} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
    // And a duplicate manifest must fail closed at the decision layer.
    const decision = decideCouncilFromManifest(
      ['security'],
      dup as unknown as CouncilResultManifest,
      'any_blocking_member'
    );
    expect(decision.decision).toBe('block');
    expect(decision.missingSpecialistIds).toEqual(['security']);
  });

  it('does not treat a longer version tag (v10 / v1junk) as a v1 marker', () => {
    const manifest = { specialists: [{ specialistId: 'security', vote: 'pass', findings: [] }] };
    expect(
      parseCouncilResultManifest(
        `<!-- ${COUNCIL_RESULT_MARKER_TAG}0 ${JSON.stringify(manifest)} -->`
      ).status
    ).toBe('missing');
    expect(
      parseCouncilResultManifest(
        `<!-- ${COUNCIL_RESULT_MARKER_TAG}junk ${JSON.stringify(manifest)} -->`
      ).status
    ).toBe('missing');
  });

  it('ignores marker text embedded inside a finding and captures the real manifest', () => {
    // A specialist quotes the marker in its rationale. JSON.stringify does not escape it,
    // so the serialized message contains a second, embedded marker occurrence.
    const real = {
      specialists: [
        {
          specialistId: 'security',
          vote: 'block',
          findings: [
            {
              path: 'a.ts',
              line: 1,
              severity: 'high',
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
    expect(capture.manifest.specialists[0].vote).toBe('block');
  });

  it('a malformed LATEST top-level marker stays invalid and does not fall back to an earlier valid one', () => {
    const earlierPass = { specialists: [{ specialistId: 'security', vote: 'pass', findings: [] }] };
    // Later top-level marker is malformed (missing vote) — must fail closed, not reuse the earlier pass.
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(earlierPass)} -->\n<!-- ${COUNCIL_RESULT_MARKER_TAG} {"specialists":[{"specialistId":"security"}]} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('ignores many embedded marker prefixes inside a finding and captures the real manifest', () => {
    const noise = `prefix <!-- ${COUNCIL_RESULT_MARKER_TAG} `.repeat(20);
    const real = {
      specialists: [
        {
          specialistId: 'security',
          vote: 'block',
          findings: [{ path: 'a.ts', line: 1, severity: 'high', rationale: noise }],
        },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(real)} -->`;
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(capture.manifest.specialists[0].vote).toBe('block');
  });

  it('does not swallow unrelated JSON when the marker has no immediate payload', () => {
    // Marker with no `{` on its line, followed later by manifest-shaped JSON that is NOT
    // framed by this marker. Must not be captured.
    const stray = JSON.stringify({
      specialists: [{ specialistId: 'security', vote: 'pass', findings: [] }],
    });
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} -->\nHere is some JSON: ${stray}`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('requires the closing --> frame after the JSON object', () => {
    const manifest = { specialists: [{ specialistId: 'security', vote: 'pass', findings: [] }] };
    // Object present after the tag but not framed by a closing `-->`.
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(manifest)} and then prose`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('ignores an embedded marker preceded by a Unicode line separator (U+2028/U+2029)', () => {
    // JS `^m` treats U+2028/U+2029 as line starts, and JSON.stringify leaves them
    // unescaped — so a finding containing one before the marker must NOT be treated as a
    // top-level marker.
    const real = {
      specialists: [
        {
          specialistId: 'security',
          vote: 'block',
          findings: [
            {
              path: 'a.ts',
              line: 1,
              severity: 'high',
              rationale: `line1\u2028<!-- ${COUNCIL_RESULT_MARKER_TAG} {"specialists":[]} -->\u2029end`,
            },
          ],
        },
      ],
    };
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(real)} -->`;
    // Sanity: the serialized text really contains a raw U+2028 (unescaped by JSON.stringify).
    expect(text).toContain('\u2028');
    const capture = parseCouncilResultManifest(text);
    expect(capture.status).toBe('captured');
    if (capture.status !== 'captured') throw new Error('unreachable');
    expect(capture.manifest.specialists[0].vote).toBe('block');
  });

  it('enforces the byte cap for unpaired surrogates (cannot undercount past 128 KiB)', () => {
    // `\uD800\u0800` = an unpaired high surrogate + a BMP char = 6 UTF-8 bytes (3-byte
    // replacement char + 3-byte char), NOT 4. 25k of them is ~150 KiB, over the cap.
    // Character count (~50k) stays under the scan bound, so the byte cap must catch it.
    const seq = '\uD800\u0800'.repeat(25_000);
    const payload = `{"specialists":[],"x":"${seq}"}`;
    const text = `<!-- ${COUNCIL_RESULT_MARKER_TAG} ${payload} -->`;
    expect(parseCouncilResultManifest(text).status).toBe('invalid');
  });

  it('does not treat a mid-line (non-line-anchored) marker as top-level', () => {
    const manifest = { specialists: [{ specialistId: 'security', vote: 'pass', findings: [] }] };
    // Marker preceded by non-whitespace on the same line is not a top-level marker.
    expect(
      parseCouncilResultManifest(
        `prefix <!-- ${COUNCIL_RESULT_MARKER_TAG} ${JSON.stringify(manifest)} -->`
      ).status
    ).toBe('missing');
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
  const manifest: CouncilResultManifest = {
    specialists: [
      { specialistId: 'security', vote: 'block', findings: [] },
      { specialistId: 'unknown', vote: 'pass', findings: [] },
    ],
  };

  it('surfaces a configured specialist absent from the manifest as missing (not abstain)', () => {
    const coverage = reconcileCouncilVotes(['security', 'performance'], manifest);
    expect(coverage.votes).toEqual([{ specialistId: 'security', vote: 'block' }]);
    expect(coverage.missingSpecialistIds).toEqual(['performance']);
  });

  it('ignores manifest entries for specialists we did not configure', () => {
    const coverage = reconcileCouncilVotes(['security'], manifest);
    expect(coverage.votes).toEqual([{ specialistId: 'security', vote: 'block' }]);
    expect(coverage.missingSpecialistIds).toEqual([]);
  });

  it('keeps a legitimately returned abstain vote as abstain', () => {
    const coverage = reconcileCouncilVotes(['security'], {
      specialists: [{ specialistId: 'security', vote: 'abstain', findings: [] }],
    });
    expect(coverage.votes).toEqual([{ specialistId: 'security', vote: 'abstain' }]);
    expect(coverage.missingSpecialistIds).toEqual([]);
  });
});

describe('decideCouncilFromManifest (coverage-aware)', () => {
  const strategies = ['any_blocking_member', 'majority', 'unanimous_required'] as const;

  it('blocks under EVERY strategy when a configured specialist is missing (fail closed)', () => {
    const manifest: CouncilResultManifest = {
      specialists: [{ specialistId: 'security', vote: 'pass', findings: [] }],
    };
    for (const strategy of strategies) {
      const result = decideCouncilFromManifest(['security', 'performance'], manifest, strategy);
      expect(result.decision).toBe('block');
      expect(result.missingSpecialistIds).toEqual(['performance']);
    }
  });

  it('passes when every configured specialist reported and all pass', () => {
    const manifest: CouncilResultManifest = {
      specialists: [
        { specialistId: 'security', vote: 'pass', findings: [] },
        { specialistId: 'performance', vote: 'pass', findings: [] },
      ],
    };
    const result = decideCouncilFromManifest(
      ['security', 'performance'],
      manifest,
      'any_blocking_member'
    );
    expect(result.decision).toBe('pass');
    expect(result.missingSpecialistIds).toEqual([]);
  });

  it('does not block on a legitimately returned abstain under any_blocking_member (strategy A)', () => {
    const manifest: CouncilResultManifest = {
      specialists: [
        { specialistId: 'security', vote: 'abstain', findings: [] },
        { specialistId: 'performance', vote: 'pass', findings: [] },
      ],
    };
    const result = decideCouncilFromManifest(
      ['security', 'performance'],
      manifest,
      'any_blocking_member'
    );
    expect(result.decision).toBe('pass');
  });

  it('fails closed on a duplicate configured id (a specialist cannot be counted twice)', () => {
    const manifest: CouncilResultManifest = {
      specialists: [{ specialistId: 'security', vote: 'pass', findings: [] }],
    };
    // Without the guard, ['security','security'] would append security's pass vote twice
    // and could flip a majority. It is counted once and treated as unreliable coverage.
    const result = decideCouncilFromManifest(['security', 'security'], manifest, 'majority');
    expect(result.decision).toBe('block');
    expect(result.missingSpecialistIds).toEqual(['security']);
    expect(result.votes).toEqual([]);
  });
});

describe('parseGovernanceMarker', () => {
  it('parses member votes and strips any model-authored overall decision', () => {
    // The model emits `decision`, but it is code-owned — the parsed result must not carry
    // it (it could contradict computeCouncilDecision in the UI).
    const gov = { members: [{ id: 'security', vote: 'pass' }], decision: 'pass' };
    const parsed = parseGovernanceMarker(
      `<!-- kilo-review-governance:v1 ${JSON.stringify(gov)} -->`
    );
    expect(parsed).toEqual({ members: [{ id: 'security', vote: 'pass', highestSeverity: null }] });
    expect(parsed as unknown as Record<string, unknown>).not.toHaveProperty('decision');
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

  it('parses when a member reason contains --> and braces', () => {
    const gov = {
      members: [{ id: 'security', vote: 'warn', reason: 'template `${x}` and --> in code' }],
      decision: 'warn',
    };
    const parsed = parseGovernanceMarker(
      `<!-- kilo-review-governance:v1 ${JSON.stringify(gov)} -->`
    );
    expect(parsed?.members[0].vote).toBe('warn');
    expect(parsed?.members[0].reason).toContain('-->');
  });
});

describe('council config helpers', () => {
  // One enabled (security) + one disabled (performance).
  const council: CodeReviewCouncilConfig = {
    enabled: true,
    aggregation_strategy: 'any_blocking_member',
    specialists: [
      presetToSpecialist(COUNCIL_SPECIALIST_PRESETS[0]),
      { ...presetToSpecialist(COUNCIL_SPECIALIST_PRESETS[1]), enabled: false },
    ],
  };
  // Two enabled specialists (meets COUNCIL_MIN_SPECIALISTS).
  const activeCouncil: CodeReviewCouncilConfig = {
    enabled: true,
    aggregation_strategy: 'any_blocking_member',
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
    // Below the minimum (only one enabled) must NOT be active.
    expect(isCouncilActive(council)).toBe(false);
    expect(isCouncilActive({ ...activeCouncil, enabled: false })).toBe(false);
    expect(isCouncilActive({ ...activeCouncil, specialists: [] })).toBe(false);
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
