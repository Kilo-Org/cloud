import { describe, expect, it } from 'vitest';

import {
  councilSurface,
  parseRequiredLabels,
  wouldStarveCouncil,
} from '@/lib/code-reviewer-council';

describe('parseRequiredLabels', () => {
  it('splits on commas, trims each label and drops the empty ones', () => {
    expect(parseRequiredLabels(' council , deep review ,, ')).toEqual({
      ok: true,
      labels: ['council', 'deep review'],
    });
  });

  it('keeps one label per case-insensitive match, in the casing first written', () => {
    expect(parseRequiredLabels('Council, council, COUNCIL, release')).toEqual({
      ok: true,
      labels: ['Council', 'release'],
    });
  });

  it('refuses a draft past the server label count instead of cutting it down', () => {
    const labels = Array.from({ length: 21 }, (_, index) => `label-${index}`);
    expect(parseRequiredLabels(labels.join(','))).toEqual({ ok: false, problem: 'tooMany' });
  });

  it('counts case-insensitive duplicates once against the label count', () => {
    const labels = Array.from({ length: 20 }, (_, index) => `label-${index}`);
    const draft = [...labels, ...labels.map(label => label.toUpperCase())];
    expect(parseRequiredLabels(draft.join(',')).ok).toBe(true);
  });

  it('keeps a draft at exactly the server label count', () => {
    const labels = Array.from({ length: 20 }, (_, index) => `label-${index}`);
    expect(parseRequiredLabels(labels.join(',')).ok).toBe(true);
  });

  it('refuses a label longer than the server maximum instead of dropping it', () => {
    const tooLong = 'a'.repeat(101);
    expect(parseRequiredLabels(`ok, ${tooLong}`)).toEqual({ ok: false, problem: 'tooLong' });
  });

  it('keeps a label at exactly the server maximum', () => {
    const atLimit = 'a'.repeat(100);
    expect(parseRequiredLabels(atLimit)).toEqual({ ok: true, labels: [atLimit] });
  });

  it('returns nothing for an empty field', () => {
    expect(parseRequiredLabels('')).toEqual({ ok: true, labels: [] });
    expect(parseRequiredLabels('   ,  ')).toEqual({ ok: true, labels: [] });
  });
});

const specialist = (id: string, enabled: boolean) => ({ id, enabled });

const councilWith = (enabled: boolean, specialists: { id: string; enabled: boolean }[]) => ({
  enabled,
  specialists,
});

describe('councilSurface', () => {
  it('refuses a platform that has no council even when the gate is open', () => {
    expect(councilSurface({ pending: false, allowed: true, platformSupportsCouncil: false })).toBe(
      'unavailable'
    );
  });

  it('keeps the surface blank while the entitlement read is in flight', () => {
    expect(councilSurface({ pending: true, allowed: false, platformSupportsCouncil: true })).toBe(
      'loading'
    );
  });

  it('refuses a settled organisation that is not entitled', () => {
    expect(councilSurface({ pending: false, allowed: false, platformSupportsCouncil: true })).toBe(
      'unavailable'
    );
  });

  it('paints the editor only for a supported, entitled organisation', () => {
    expect(councilSurface({ pending: false, allowed: true, platformSupportsCouncil: true })).toBe(
      'editor'
    );
  });
});

describe('wouldStarveCouncil', () => {
  it('refuses the toggle that would leave an enabled council below the minimum', () => {
    const council = councilWith(true, [
      specialist('security', true),
      specialist('performance', true),
      specialist('testing', false),
    ]);
    expect(wouldStarveCouncil(council, 'performance', false)).toBe(true);
  });

  it('allows a toggle while enough specialists stay enabled', () => {
    const council = councilWith(true, [
      specialist('security', true),
      specialist('performance', true),
      specialist('testing', true),
    ]);
    expect(wouldStarveCouncil(council, 'performance', false)).toBe(false);
  });

  it('never blocks enabling a specialist', () => {
    const council = councilWith(true, [
      specialist('security', true),
      specialist('performance', false),
    ]);
    expect(wouldStarveCouncil(council, 'performance', true)).toBe(false);
  });

  it('lets a council that is switched off hold as few specialists as it likes', () => {
    const council = councilWith(false, [
      specialist('security', true),
      specialist('performance', true),
    ]);
    expect(wouldStarveCouncil(council, 'performance', false)).toBe(false);
  });

  it('does not block a specialist that is already disabled', () => {
    const council = councilWith(true, [
      specialist('security', true),
      specialist('performance', true),
      specialist('testing', false),
    ]);
    expect(wouldStarveCouncil(council, 'testing', false)).toBe(false);
  });
});
