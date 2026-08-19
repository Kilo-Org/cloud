import { describe, expect, it } from 'vitest';

import {
  councilDecisionLabel,
  councilVoteLabel,
  flattenCouncilFindings,
} from './review-detail-helpers';

type Finding = { path: string; severity: string };

function specialist(findings: Finding[]) {
  return { findings };
}

describe('flattenCouncilFindings', () => {
  it('returns no findings for a null council result', () => {
    expect(flattenCouncilFindings<Finding>(null)).toEqual([]);
  });

  it('returns no findings for an undefined council result', () => {
    expect(flattenCouncilFindings<Finding>(undefined)).toEqual([]);
  });

  it('returns no findings when every specialist has zero findings', () => {
    expect(
      flattenCouncilFindings<Finding>({ specialists: [specialist([]), specialist([])] })
    ).toEqual([]);
  });

  it('flattens findings across specialists in order', () => {
    const result = flattenCouncilFindings<Finding>({
      specialists: [
        specialist([
          { path: 'a.ts', severity: 'critical' },
          { path: 'b.ts', severity: 'warning' },
        ]),
        specialist([{ path: 'c.ts', severity: 'nitpick' }]),
      ],
    });
    expect(result.map(f => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('councilDecisionLabel', () => {
  it('labels pass and block', () => {
    expect(councilDecisionLabel('pass')).toBe('Pass');
    expect(councilDecisionLabel('block')).toBe('Block');
  });

  it('labels a null decision (advisory) as no decision', () => {
    expect(councilDecisionLabel(null)).toBe('No decision');
    expect(councilDecisionLabel(undefined)).toBe('No decision');
  });
});

describe('councilVoteLabel', () => {
  it('labels pass and block', () => {
    expect(councilVoteLabel('pass')).toBe('Pass');
    expect(councilVoteLabel('block')).toBe('Block');
  });

  it('labels a null vote as no result', () => {
    expect(councilVoteLabel(null)).toBe('No result');
    expect(councilVoteLabel(undefined)).toBe('No result');
  });
});
