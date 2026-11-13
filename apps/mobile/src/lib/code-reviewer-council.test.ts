import { describe, expect, it } from 'vitest';

import { parseRequiredLabels } from '@/lib/code-reviewer-council';

describe('parseRequiredLabels', () => {
  it('splits on commas, trims each label and drops the empty ones', () => {
    expect(parseRequiredLabels(' council , deep review ,, ')).toEqual(['council', 'deep review']);
  });

  it('keeps one label per case-insensitive match, in the casing first written', () => {
    expect(parseRequiredLabels('Council, council, COUNCIL, release')).toEqual([
      'Council',
      'release',
    ]);
  });

  it('drops a label longer than the server maximum', () => {
    const tooLong = 'a'.repeat(101);
    expect(parseRequiredLabels(`ok, ${tooLong}`)).toEqual(['ok']);
  });

  it('keeps a label at exactly the server maximum', () => {
    const atLimit = 'a'.repeat(100);
    expect(parseRequiredLabels(atLimit)).toEqual([atLimit]);
  });

  it('stops at the server maximum number of labels', () => {
    const labels = Array.from({ length: 25 }, (_, index) => `label-${index}`);
    const parsed = parseRequiredLabels(labels.join(','));
    expect(parsed).toHaveLength(20);
    expect(parsed.at(-1)).toBe('label-19');
  });

  it('returns nothing for an empty field', () => {
    expect(parseRequiredLabels('')).toEqual([]);
    expect(parseRequiredLabels('   ,  ')).toEqual([]);
  });
});
