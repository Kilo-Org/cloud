import { describe, expect, it } from 'vitest';

import {
  councilDecisionLabel,
  councilVoteLabel,
  flattenCouncilFindings,
  selectRetryAction,
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

describe('selectRetryAction', () => {
  const enabled = { isEnabled: true, actionRequired: null };

  it('keeps Retry for a manual review whatever the config says', () => {
    expect(
      selectRetryAction({
        hasManualConfig: true,
        configPending: false,
        config: { isEnabled: false, actionRequired: { reason: 'byok_invalid_key' } },
      })
    ).toBe('retry');
  });

  it('shows nothing while the config loads', () => {
    expect(
      selectRetryAction({ hasManualConfig: false, configPending: true, config: undefined })
    ).toBeNull();
  });

  it('keeps Retry when the config is unknown', () => {
    expect(
      selectRetryAction({ hasManualConfig: false, configPending: false, config: undefined })
    ).toBe('retry');
  });

  it('keeps Retry when Code Reviewer is on and needs no attention', () => {
    expect(
      selectRetryAction({ hasManualConfig: false, configPending: false, config: enabled })
    ).toBe('retry');
  });

  it('links to the settings when Code Reviewer is off', () => {
    expect(
      selectRetryAction({
        hasManualConfig: false,
        configPending: false,
        config: { isEnabled: false, actionRequired: null },
      })
    ).toBe('fix-settings');
  });

  it('links to the settings when the configuration needs attention', () => {
    expect(
      selectRetryAction({
        hasManualConfig: false,
        configPending: false,
        config: { ...enabled, actionRequired: { reason: 'byok_invalid_key' } },
      })
    ).toBe('fix-settings');
  });
});
