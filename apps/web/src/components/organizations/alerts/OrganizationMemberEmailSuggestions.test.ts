import { activeMemberEmailOptions } from './OrganizationMemberEmailSuggestions';

describe('activeMemberEmailOptions', () => {
  const members = [
    { status: 'active' as const, name: 'Taylor Operations', email: 'taylor@example.com' },
    { status: 'invited' as const, email: 'invited@example.com' },
    { status: 'active' as const, name: 'Alex Finance', email: 'alex@example.com' },
  ];

  test('suggests active organization members in name order', () => {
    expect(activeMemberEmailOptions(members, [])).toEqual([
      { name: 'Alex Finance', email: 'alex@example.com' },
      { name: 'Taylor Operations', email: 'taylor@example.com' },
    ]);
  });

  test('omits configured recipients case-insensitively', () => {
    expect(activeMemberEmailOptions(members, ['ALEX@EXAMPLE.COM'])).toEqual([
      { name: 'Taylor Operations', email: 'taylor@example.com' },
    ]);
  });
});
