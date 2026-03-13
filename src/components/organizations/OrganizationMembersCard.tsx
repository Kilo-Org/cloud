'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Plus,
  Copy,
  Users,
  Gauge,
  Infinity as InfinityIcon,
  UserPen,
  ChevronRight,
  UserCog,
} from 'lucide-react';
import Link from 'next/link';
import { AddMemberDialog } from '../../app/admin/components/OrganizationAdmin/AddMemberDialog';
import { InviteMemberDialog } from './members/InviteMemberDialog';
import { MemberRoleDropdown } from './members/MemberRoleDropdown';
import { EditDailyUsageLimitUsdDialog } from './members/EditDailyUsageLimitUsdDialog';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import {
  useOrganizationWithMembers,
  useDeleteOrganizationInvitation,
  useRemoveMember,
} from '@/app/api/organizations/hooks';
import { ErrorCard } from '../ErrorCard';
import { LoadingCard } from '../LoadingCard';
import type {
  OrganizationRole,
  OrganizationMember,
  OrganizationWithMembers,
} from '@/lib/organizations/organization-types';
import {
  useIsKiloAdmin,
  useUserOrganizationRole,
} from '@/components/organizations/OrganizationContext';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { useOrganizationReadOnly } from '@/lib/organizations/use-organization-read-only';

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const getStatusBadgeVariant = (status: string) => {
  switch (status) {
    case 'active':
      return 'default';
    case 'invited':
      return 'secondary';
    default:
      return 'outline';
  }
};

type DailyUsageLimitDisplayProps = {
  member: OrganizationMember;
};

function DailyUsageLimitDisplay({ member }: DailyUsageLimitDisplayProps) {
  if (member.dailyUsageLimitUsd !== null) {
    return <span>Daily limit: ${member.dailyUsageLimitUsd.toFixed(2)}</span>;
  }
  return null;
}

const isPrivilegedRole = (role: OrganizationRole): boolean =>
  role === 'owner' || role === 'billing_manager';

// Business rules for member removal:
// - Kilo admins can remove anyone
// - Owners and billing managers can remove anyone except themselves
// - Members cannot remove anyone
const canRemoveMember = (
  currentUserRole: OrganizationRole,
  isKiloAdmin: boolean,
  targetMemberRole: OrganizationRole,
  isCurrentUser: boolean
): boolean => {
  // Kilo admin can remove anyone including themselves
  if (isKiloAdmin) return true;

  // Cannot remove yourself
  if (isCurrentUser) return false;

  // Owners and billing managers can remove anyone (except themselves)
  if (isPrivilegedRole(currentUserRole)) return true;

  // Members cannot remove anyone
  return false;
};

type DeleteMemberButtonProps = {
  organizationId: string;
  member: OrganizationMember;
};

function DeleteMemberButton({ organizationId, member }: DeleteMemberButtonProps) {
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();
  const session = useSession();
  const kiloUserId = session?.data?.user?.id;
  const kiloUserEmail = session?.data?.user?.email;
  const removeMember = useRemoveMember();

  // Check if this member is the current user by comparing both ID and email
  const isCurrentUser =
    (member.status === 'active' && member.id === kiloUserId) || member.email === kiloUserEmail;

  // Only show delete button for active members and if user has permission to remove
  const canRemove = canRemoveMember(currentUserRole, isKiloAdmin, member.role, isCurrentUser);

  if (member.status !== 'active' || !canRemove) {
    return null;
  }

  const handleDelete = async () => {
    if (member.status !== 'active') {
      toast.error('Invalid member');
      return;
    }

    try {
      await removeMember.mutateAsync({ organizationId, memberId: member.id });
      toast.success(`Successfully removed ${member.name || member.email} from the organization`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove member');
    }
  };

  return <InlineDeleteConfirmation onDelete={handleDelete} isLoading={removeMember.isPending} />;
}

type DeleteInvitationButtonProps = {
  organizationId: string;
  member: OrganizationMember;
};

function DeleteInvitationButton({ organizationId, member }: DeleteInvitationButtonProps) {
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();
  const deleteInvitation = useDeleteOrganizationInvitation();

  // Only show delete button for pending invitations
  if (member.status !== 'invited') {
    return null;
  }

  // Apply same role restrictions as invitation creation
  // - Owners and billing managers can delete any invitation
  // - Members cannot delete invitations
  const canDelete = isKiloAdmin || isPrivilegedRole(currentUserRole);

  if (!canDelete) {
    return null;
  }

  const handleDelete = async () => {
    if (member.status !== 'invited') {
      toast.error('Invalid invitation');
      return;
    }

    try {
      await deleteInvitation.mutateAsync({ organizationId, inviteId: member.inviteId });
      toast.success('Invitation deleted successfully');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete invitation');
    }
  };

  return (
    <InlineDeleteConfirmation onDelete={handleDelete} isLoading={deleteInvitation.isPending} />
  );
}

type InvitedBadgeProps = {
  member: OrganizationMember;
};

function InvitedBadge({ member }: InvitedBadgeProps) {
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();

  if (member.status !== 'invited') {
    return null;
  }

  const canCopy = isKiloAdmin || isPrivilegedRole(currentUserRole);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      await navigator.clipboard.writeText(member.inviteUrl);
      toast.success('Invite URL copied to clipboard');
    } catch (_error) {
      toast.error('Failed to copy invite URL');
    }
  };

  if (!canCopy) {
    return <Badge variant={getStatusBadgeVariant(member.status)}>{member.status}</Badge>;
  }

  return (
    <Badge
      variant={getStatusBadgeVariant(member.status)}
      className="group hover:bg-secondary/80 relative cursor-pointer transition-colors"
      onClick={handleCopy}
    >
      {member.status}
      <span title="Copy invite URL to clipboard">
        <Copy className="ml-1 hidden h-3 w-3 transition-all group-hover:inline" />
      </span>
    </Badge>
  );
}

type EditLimitButtonProps = {
  organization: OrganizationWithMembers;
  member: OrganizationMember;
};

function EditLimitButton({ organization, member }: EditLimitButtonProps) {
  const { id: organizationId } = organization;
  const [isEditLimitDialogOpen, setIsEditLimitDialogOpen] = useState(false);
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();

  // Don't show edit limit button for non-enterprise orgs ever
  if (organization.plan !== 'enterprise') {
    return null;
  }

  // all new orgs default to false, this is only for legacy design partners.
  if (organization.settings.enable_usage_limits === false) {
    return null;
  }

  // Only show edit limit button for active members and if user has permission (admin/owner/billing_manager)
  const canEditLimit =
    member.status === 'active' && (isKiloAdmin || isPrivilegedRole(currentUserRole));

  if (!canEditLimit) {
    return null;
  }

  const isUnlimited = member.dailyUsageLimitUsd === null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setIsEditLimitDialogOpen(true)}
        className="h-8 w-8 p-0"
        title="Edit daily usage limit"
      >
        {isUnlimited ? (
          <InfinityIcon className="text-muted-foreground h-4 w-4" />
        ) : (
          <Gauge className="h-4 w-4" />
        )}
      </Button>

      <EditDailyUsageLimitUsdDialog
        open={isEditLimitDialogOpen}
        onOpenChange={setIsEditLimitDialogOpen}
        organizationId={organizationId}
        member={member}
        onLimitUpdated={() => {
          // The dialog will trigger a refetch via the mutation's onSuccess
        }}
      />
    </>
  );
}

export function OrganizationAdminMembers({
  organizationId,
  showAdminLinks = false,
}: {
  organizationId: string;
  showAdminLinks?: boolean;
}) {
  const [isAddMemberDialogOpen, setIsAddMemberDialogOpen] = useState(false);
  const [isInviteMemberDialogOpen, setIsInviteMemberDialogOpen] = useState(false);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);

  const isKiloAdmin = useIsKiloAdmin();
  const currentUserRole = useUserOrganizationRole();
  const session = useSession();
  const kiloUserId = session?.data?.user?.id;
  const kiloUserEmail = session?.data?.user?.email;
  const isReadOnly = useOrganizationReadOnly(organizationId);

  const {
    data: organizationData,
    isLoading,
    error,
    refetch,
  } = useOrganizationWithMembers(organizationId);

  const handleMemberAdded = () => {
    void refetch();
  };

  if (isLoading) {
    return <LoadingCard title="Members" description="Loading organization members..." />;
  }

  if (error) {
    return (
      <ErrorCard
        title="Members"
        description="Error loading organization members"
        error={error}
        onRetry={() => refetch()}
      />
    );
  }

  if (!organizationData) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Organization not found</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">No organization data available</p>
        </CardContent>
      </Card>
    );
  }

  const members = (organizationData.members || []).sort((a, b) => {
    // Extract first name (everything before the first space, or the full name if no space)
    const getFirstName = (member: typeof a) => {
      const name = (member.status === 'active' ? member.name : '') || member.email || '';
      return name.split(' ')[0].toLowerCase();
    };

    const firstNameA = getFirstName(a);
    const firstNameB = getFirstName(b);

    return firstNameA.localeCompare(firstNameB);
  });

  // Show "Add Member" button only for Kilo admins
  const showAddMemberButton = isKiloAdmin;

  // Show "Invite Member" button for all roles except 'member'
  const showInviteMemberButton = currentUserRole !== 'member';

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>
                <Users className="mr-2 inline h-4 w-4" />
                Members ({members.length})
              </CardTitle>
              <CardDescription>Team members and pending invitations</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {showAddMemberButton && (
                <Button
                  onClick={() => setIsAddMemberDialogOpen(true)}
                  size="sm"
                  className="flex items-center gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Add Member
                </Button>
              )}
              {showInviteMemberButton && (
                <Button
                  onClick={() => setIsInviteMemberDialogOpen(true)}
                  size="sm"
                  variant="outline"
                  className="flex items-center gap-2"
                  disabled={isReadOnly}
                  title={isReadOnly ? 'Upgrade to enable' : undefined}
                >
                  <Plus className="h-4 w-4" />
                  Invite Member
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {members.length === 0 ? (
            <p className="text-muted-foreground p-6 text-sm">No members found</p>
          ) : (
            <div className="max-h-[800px] overflow-y-auto">
              <div className="space-y-4 p-6">
                {members.map(member => {
                  const memberId = member.status === 'active' ? member.id : member.inviteId;
                  const isEditing = editingMemberId === memberId;
                  const isCurrentUser =
                    (member.status === 'active' && member.id === kiloUserId) ||
                    member.email === kiloUserEmail;

                  // Determine what actions are available for this member
                  const canEditRole =
                    member.status === 'active' &&
                    (isKiloAdmin || isPrivilegedRole(currentUserRole)) &&
                    (!isCurrentUser || isKiloAdmin);
                  const canEditLimit =
                    organizationData.plan === 'enterprise' &&
                    member.status === 'active' &&
                    (isKiloAdmin || isPrivilegedRole(currentUserRole));
                  const canDelete =
                    member.status === 'active'
                      ? canRemoveMember(currentUserRole, isKiloAdmin, member.role, isCurrentUser)
                      : isKiloAdmin || isPrivilegedRole(currentUserRole);

                  const hasAnyEditableActions = canEditRole || canEditLimit || canDelete;

                  return (
                    <div
                      key={memberId}
                      className="flex items-center justify-between border-b pb-4 last:border-b-0"
                    >
                      <div className="flex flex-1 items-center justify-between gap-4">
                        <div className="flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            {member.status === 'active' && member.name ? (
                              showAdminLinks ? (
                                <Link
                                  href={`/admin/users/${member.id}`}
                                  className="flex items-center gap-1 font-medium hover:underline"
                                >
                                  {member.name}
                                  <UserCog className="h-3 w-3" />
                                </Link>
                              ) : (
                                <span className="font-medium">{member.name}</span>
                              )
                            ) : (
                              <span className="text-muted-foreground italic">
                                Pending invitation
                              </span>
                            )}
                            <InvitedBadge member={member} />
                          </div>
                          <p className="text-muted-foreground text-sm">{member.email}</p>
                          <div className="text-muted-foreground flex items-center gap-4 text-xs">
                            <span>
                              Joined: {member.inviteDate ? formatDate(member.inviteDate) : 'N/A'}
                            </span>
                            <DailyUsageLimitDisplay member={member} />
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {!isEditing ? (
                          // Non-editing mode: show role badge and edit button
                          <>
                            <MemberRoleDropdown
                              organizationId={organizationId}
                              member={member}
                              showAsReadOnly={true}
                            />
                            {hasAnyEditableActions && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setEditingMemberId(memberId)}
                                className="h-8 w-8 p-0"
                                title="Edit member"
                              >
                                <UserPen className="h-4 w-4" />
                              </Button>
                            )}
                          </>
                        ) : (
                          // Editing mode: show all controls plus cancel button
                          <>
                            <MemberRoleDropdown
                              organizationId={organizationId}
                              member={member}
                              showAsReadOnly={false}
                            />
                            <EditLimitButton organization={organizationData} member={member} />
                            <DeleteMemberButton organizationId={organizationId} member={member} />
                            <DeleteInvitationButton
                              organizationId={organizationId}
                              member={member}
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setEditingMemberId(null)}
                              className="h-8 w-8 p-0"
                              title="Cancel editing"
                            >
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {isKiloAdmin && (
        <AddMemberDialog
          open={isAddMemberDialogOpen}
          onOpenChange={setIsAddMemberDialogOpen}
          organizationId={organizationId}
          onMemberAdded={handleMemberAdded}
        />
      )}

      {showInviteMemberButton && (
        <InviteMemberDialog
          open={isInviteMemberDialogOpen}
          onOpenChange={setIsInviteMemberDialogOpen}
          organizationId={organizationId}
          onMemberInvited={handleMemberAdded}
        />
      )}
    </>
  );
}
