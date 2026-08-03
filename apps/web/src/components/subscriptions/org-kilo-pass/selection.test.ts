import { childAllocationInput, loadOrgKiloPassSelection } from './selection';

describe('childAllocationInput', () => {
  test('omits the parent remainder and zero-value child assignments', () => {
    expect(
      childAllocationInput([
        { organizationId: 'parent', organizationName: 'Parent', kind: 'parent', passCount: 10 },
        { organizationId: 'child-a', organizationName: 'Child A', kind: 'child', passCount: 4 },
        { organizationId: 'child-b', organizationName: 'Child B', kind: 'child', passCount: 0 },
      ])
    ).toEqual([{ childOrganizationId: 'child-a', passCount: 4 }]);
  });

  test('parses a complete persisted selection', () => {
    const selection = {
      tier: 'tier_49',
      allocations: [
        { organizationId: 'parent', organizationName: 'Parent', kind: 'parent', passCount: 2 },
      ],
    };
    Object.assign(globalThis, {
      sessionStorage: { getItem: () => JSON.stringify(selection) },
    });

    expect(loadOrgKiloPassSelection('org-1')).toEqual(selection);
  });

  test.each([
    '{',
    JSON.stringify({ tier: 'tier_49', allocations: [{ organizationId: 'child' }] }),
    JSON.stringify({ tier: 'unknown', allocations: [] }),
    JSON.stringify({
      tier: 'tier_49',
      allocations: [
        { organizationId: 'child', organizationName: 'Child', kind: 'child', passCount: -1 },
      ],
    }),
  ])('rejects malformed persisted selection %s', raw => {
    Object.assign(globalThis, { sessionStorage: { getItem: () => raw } });

    expect(loadOrgKiloPassSelection('org-1')).toBeNull();
  });
});
