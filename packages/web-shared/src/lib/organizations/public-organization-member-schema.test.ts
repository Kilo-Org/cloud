import {
  ActiveOrganizationMemberSchema,
  PublicActiveOrganizationMemberSchema,
  PublicOrganizationMembersSchema,
} from './organization-types';

const ACTIVE_MEMBER = {
  id: 'user_1',
  name: 'Active Member',
  email: 'active@example.com',
  role: 'member' as const,
  status: 'active' as const,
  inviteDate: null,
  dailyUsageLimitUsd: null,
  currentDailyUsageUsd: null,
  childOrganizationMemberships: [{ id: 'org_child', name: 'Child', role: 'member' as const }],
};

describe('PublicActiveOrganizationMemberSchema', () => {
  it('carries the child-organization memberships on the admin shape', () => {
    expect(ActiveOrganizationMemberSchema.parse(ACTIVE_MEMBER).childOrganizationMemberships).toEqual(
      [{ id: 'org_child', name: 'Child', role: 'member' }]
    );
  });

  it('strips the child-organization memberships and the usage fields it hides', () => {
    const parsed = PublicActiveOrganizationMemberSchema.parse(ACTIVE_MEMBER);

    expect(parsed).not.toHaveProperty('childOrganizationMemberships');
    expect(parsed).not.toHaveProperty('dailyUsageLimitUsd');
    expect(parsed).not.toHaveProperty('currentDailyUsageUsd');
    expect(parsed).toMatchObject({ id: 'user_1', role: 'member', status: 'active' });
  });

  it('strips the field in the published member list shape too', () => {
    const [parsed] = PublicOrganizationMembersSchema.parse([ACTIVE_MEMBER]);

    expect(parsed).not.toHaveProperty('childOrganizationMemberships');
  });
});
