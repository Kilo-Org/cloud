import { childAllocationInput } from './selection';

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
});
