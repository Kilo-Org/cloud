import { validatePermissionRule } from './validate';
import { MAX_DESCRIPTION_LENGTH, MAX_PATTERN_LENGTH, MAX_PERMISSION_LENGTH } from './types';

describe('validatePermissionRule', () => {
  it('accepts a normal bash rule', () => {
    expect(
      validatePermissionRule({ tier: 'specific_deny', permission: 'bash', pattern: 'git push *' })
    ).toEqual({ errors: [], warnings: [] });
  });

  it('requires * for tool-level permissions', () => {
    expect(
      validatePermissionRule({ tier: 'final_deny', permission: 'read', pattern: '*.env' }).errors
    ).toHaveLength(1);
    expect(
      validatePermissionRule({ tier: 'final_deny', permission: 'read', pattern: '*' }).errors
    ).toEqual([]);
  });

  it('rejects an allow for every permission but permits a deny', () => {
    for (const tier of ['broad_allow', 'narrow_allow'] as const) {
      expect(validatePermissionRule({ tier, permission: '*', pattern: '*' }).errors).toHaveLength(
        1
      );
    }
    expect(
      validatePermissionRule({ tier: 'final_deny', permission: '*', pattern: '*' }).errors
    ).toEqual([]);
  });

  it('enforces length bounds and presence', () => {
    const result = validatePermissionRule({
      tier: 'specific_deny',
      permission: 'p'.repeat(MAX_PERMISSION_LENGTH + 1),
      pattern: 'x'.repeat(MAX_PATTERN_LENGTH + 1),
      description: 'd'.repeat(MAX_DESCRIPTION_LENGTH + 1),
    });
    expect(result.errors).toHaveLength(3);
    expect(
      validatePermissionRule({ tier: 'specific_deny', permission: ' ', pattern: '' }).errors
    ).toHaveLength(2);
  });

  it('warns about overly broad narrow allows', () => {
    expect(
      validatePermissionRule({ tier: 'narrow_allow', permission: 'bash', pattern: '*' }).warnings
    ).toHaveLength(1);
    expect(
      validatePermissionRule({ tier: 'narrow_allow', permission: 'bash', pattern: 'git *' })
        .warnings
    ).toHaveLength(1);
    expect(
      validatePermissionRule({ tier: 'narrow_allow', permission: 'bash', pattern: 'git log *' })
        .warnings
    ).toEqual([]);
    expect(
      validatePermissionRule({ tier: 'broad_allow', permission: 'bash', pattern: 'git *' }).warnings
    ).toEqual([]);
  });
});
