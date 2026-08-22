'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { useUpdateMemberRole } from '@/app/api/organizations/hooks';
import type {
  OrganizationRole,
  OrganizationMemberResponse,
} from '@/lib/organizations/organization-types';
import {
  useIsKiloAdmin,
  useUserOrganizationRole,
} from '@/components/organizations/OrganizationContext';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';

const getRoleBadgeVariant = (role: string) => {
  switch (role) {
    case 'owner':
      return 'secondary-outline';
    case 'member':
      return 'outline';
    default:
      return 'outline';
  }
};

const ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  billing_manager: 'Billing Manager',
} as const;

const ASSIGNABLE_ROLES = ['owner', 'admin', 'member', 'billing_manager'] as const;

/**
 * Mirrors the server rules in organization-members-router: owners and Kilo
 * staff may assign any role, admins may assign every role except owner, and
 * nobody else may change roles.
 */
const getAvailableRoles = (
  currentUserRole: OrganizationRole,
  isKiloAdmin: boolean
): OrganizationRole[] => {
  if (isKiloAdmin || currentUserRole === 'owner') {
    return [...ASSIGNABLE_ROLES];
  }
  if (currentUserRole === 'admin') {
    return ['admin', 'member', 'billing_manager'];
  }
  return [];
};

type MemberRoleDropdownProps = {
  organizationId: string;
  member: OrganizationMemberResponse;
  showAsReadOnly?: boolean;
};

export function MemberRoleDropdown({
  organizationId,
  member,
  showAsReadOnly = false,
}: MemberRoleDropdownProps) {
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();
  const session = useSession();
  const kiloUserId = session?.data?.user?.id;
  const kiloUserEmail = session?.data?.user?.email;

  const mutation = useUpdateMemberRole();

  const handleRoleChange = (newRole: OrganizationRole) => {
    if (member.status !== 'active') return;

    mutation.mutate(
      {
        organizationId,
        memberId: member.id,
        role: newRole,
      },
      {
        onSuccess: () => {
          toast.success(
            `Successfully updated ${member.name || member.email}'s role to ${ROLE_LABELS[newRole]}`
          );
        },
        onError: error => {
          toast.error(error instanceof Error ? error.message : 'Failed to update member role');
        },
      }
    );
  };

  const availableRoles = getAvailableRoles(currentUserRole, isKiloAdmin);
  // An admin may not act on an owner's membership, so show it as read-only.
  const canEditRole = availableRoles.length > 0 && availableRoles.includes(member.role);

  // Check if this member is the current user by comparing both ID and email
  const isCurrentUser =
    (member.status === 'active' && member.id === kiloUserId) || member.email === kiloUserEmail;

  // Show as read-only badge if explicitly requested or if user doesn't have permission to edit
  if (
    showAsReadOnly ||
    member.status !== 'active' ||
    !canEditRole ||
    (isCurrentUser && !isKiloAdmin)
  ) {
    return (
      <Badge variant={getRoleBadgeVariant(member.role)} className="h-8 px-3 text-sm font-normal">
        {ROLE_LABELS[member.role]}
      </Badge>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="flex items-center gap-2"
          disabled={mutation.isPending}
        >
          {ROLE_LABELS[member.role]}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {ASSIGNABLE_ROLES.map(role => {
          const isCurrentRole = member.role === role;
          const isAllowed = availableRoles.includes(role);
          const isDisabled = isCurrentRole || mutation.isPending || !isAllowed;

          return (
            <DropdownMenuItem
              key={role}
              onClick={() => handleRoleChange(role)}
              disabled={isDisabled}
            >
              {ROLE_LABELS[role]}
              {isCurrentRole && <span className="text-muted-foreground ml-2">(current)</span>}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
