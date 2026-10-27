type User = {
  id: string;
  google_user_email: string;
  google_user_name: string | null;
};

type ParentMemberSearchCandidate = {
  status: string;
  id?: string;
  email: string;
  name?: string | null;
};

export function searchParentOrganizationMembers(
  members: readonly ParentMemberSearchCandidate[],
  searchTerm: string,
  currentMemberEmails: ReadonlySet<string>
): User[] {
  const query = searchTerm.trim().toLowerCase();
  if (!query) return [];

  return members.flatMap(member => {
    if (member.status !== 'active' || !member.id || currentMemberEmails.has(member.email)) {
      return [];
    }
    const haystack = `${member.name ?? ''} ${member.email}`.toLowerCase();
    if (!haystack.includes(query)) return [];
    return [
      {
        id: member.id,
        google_user_email: member.email,
        google_user_name: member.name ?? null,
      },
    ];
  });
}
