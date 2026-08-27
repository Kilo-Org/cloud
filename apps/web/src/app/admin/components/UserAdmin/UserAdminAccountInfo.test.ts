import { describe, expect, it } from '@jest/globals';
import { getLoginMethods } from './UserAdminAccountInfo';

describe('getLoginMethods', () => {
  it('shows the names of each associated login provider', () => {
    expect(
      getLoginMethods(['anaconda', 'github', 'workos']).map(provider => provider.name)
    ).toEqual(['Anaconda', 'GitHub', 'Enterprise SSO']);
  });

  it('shows magic-link email login', () => {
    expect(getLoginMethods(['email']).map(provider => provider.name)).toEqual(['Email']);
  });
});
