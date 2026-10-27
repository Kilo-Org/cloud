import { searchParentOrganizationMembers } from './parent-member-search';

const parentMembers = [
  {
    status: 'active',
    id: 'parent-member',
    email: 'Parent.Member@example.com',
    name: 'Parent Member',
  },
  {
    status: 'invited',
    email: 'pending@example.com',
    name: 'pending@example.com',
  },
  {
    status: 'active',
    id: 'already-child',
    email: 'already@example.com',
    name: 'Already Child',
  },
];

describe('searchParentOrganizationMembers', () => {
  const currentMemberEmails = new Set(['already@example.com']);

  it('returns only active parent members matching the search', () => {
    expect(
      searchParentOrganizationMembers(parentMembers, 'parent.member', currentMemberEmails)
    ).toEqual([
      {
        id: 'parent-member',
        google_user_email: 'Parent.Member@example.com',
        google_user_name: 'Parent Member',
      },
    ]);
  });

  it('does not return pending parent invitations or people already in the child organization', () => {
    expect(
      searchParentOrganizationMembers(parentMembers, 'example.com', currentMemberEmails)
    ).toEqual([
      {
        id: 'parent-member',
        google_user_email: 'Parent.Member@example.com',
        google_user_name: 'Parent Member',
      },
    ]);
  });
});
