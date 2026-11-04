import {
  GIT_READ_ONLY_PRESET,
  compareRulesForDisplay,
  planPreset,
  presetResultMessage,
} from './permission-display';

describe('compareRulesForDisplay', () => {
  it('sorts by tier, then permission, then pattern', () => {
    const rules = [
      { tier: 'final_deny' as const, permission: 'bash', pattern: 'eval *' },
      { tier: 'broad_allow' as const, permission: 'bash', pattern: 'git status *' },
      { tier: 'broad_allow' as const, permission: 'bash', pattern: 'git diff *' },
      { tier: 'broad_allow' as const, permission: 'read', pattern: '*' },
      { tier: 'specific_deny' as const, permission: 'bash', pattern: 'rm *' },
    ];
    expect([...rules].sort(compareRulesForDisplay).map(rule => rule.pattern)).toEqual([
      'git diff *',
      'git status *',
      '*',
      'rm *',
      'eval *',
    ]);
  });
});

describe('planPreset', () => {
  it('skips rules that already exist', () => {
    const existing = [{ tier: 'final_deny' as const, permission: 'bash', pattern: 'eval *' }];
    const { toAdd, skipped } = planPreset(GIT_READ_ONLY_PRESET, existing);
    expect(skipped).toEqual(existing);
    expect(toAdd).toHaveLength(GIT_READ_ONLY_PRESET.length - 1);
  });

  it('includes the required final denies', () => {
    const denies = GIT_READ_ONLY_PRESET.filter(rule => rule.tier === 'final_deny').map(
      rule => rule.pattern
    );
    expect(denies).toEqual([
      'git -c *',
      'bash -c *',
      'sh -c *',
      'eval *',
      'xargs *',
      'find * -exec *',
      '*>*',
    ]);
  });
});

describe('presetResultMessage', () => {
  it('reports added, skipped, and failed rules', () => {
    expect(presetResultMessage({ added: 1, skipped: 0, failed: 0 })).toBe('Added 1 rule.');
    expect(presetResultMessage({ added: 3, skipped: 2, failed: 1 })).toBe(
      'Added 3 rules, skipped 2 that already exist, 1 couldn’t be added.'
    );
  });
});
