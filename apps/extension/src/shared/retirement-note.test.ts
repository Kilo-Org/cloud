import { describe, expect, it } from 'vitest';
import { modelNameWithRetirement, retirementNoteSuffix } from './retirement-note';

describe('retirementNoteSuffix', () => {
  it('builds the English note the web shows', () => {
    expect(retirementNoteSuffix('2026-07-01')).toBe(' (retires Jul 1)');
  });

  it('builds no note without a date', () => {
    expect(retirementNoteSuffix(undefined)).toBe('');
    expect(retirementNoteSuffix('')).toBe('');
  });
});

describe('modelNameWithRetirement', () => {
  it('appends the note to the name', () => {
    expect(modelNameWithRetirement({ name: 'Test Model', retires_on: '2026-07-01' })).toBe(
      'Test Model (retires Jul 1)'
    );
  });

  it('leaves the name alone without a date', () => {
    expect(modelNameWithRetirement({ name: 'Test Model' })).toBe('Test Model');
  });
});
