'use client';

import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';

type OrganizationMemberEmailCandidate =
  | { status: 'active'; email: string; name: string }
  | { status: 'invited'; email: string };

export type OrganizationMemberEmailOption = {
  email: string;
  name: string;
};

export function activeMemberEmailOptions(
  members: readonly OrganizationMemberEmailCandidate[],
  configuredRecipients: readonly string[]
): OrganizationMemberEmailOption[] {
  const configured = new Set(configuredRecipients.map(email => email.toLowerCase()));

  return members
    .filter(
      (member): member is Extract<OrganizationMemberEmailCandidate, { status: 'active' }> =>
        member.status === 'active' && !configured.has(member.email.toLowerCase())
    )
    .map(member => ({ email: member.email, name: member.name }))
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.email.localeCompare(right.email)
    );
}

export function OrganizationMemberEmailSuggestions({
  id,
  organizationId,
  configuredRecipients,
}: {
  id: string;
  organizationId: string;
  configuredRecipients: readonly string[];
}) {
  const { data: organization } = useOrganizationWithMembers(organizationId);
  const options = activeMemberEmailOptions(organization?.members ?? [], configuredRecipients);

  if (options.length === 0) return null;

  return (
    <datalist id={id}>
      {options.map(option => (
        <option key={option.email} value={option.email} label={option.name} />
      ))}
    </datalist>
  );
}
