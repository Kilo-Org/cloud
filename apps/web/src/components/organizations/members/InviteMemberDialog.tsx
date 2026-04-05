'use client';

import { useState, useMemo } from 'react';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { LockableContainer } from '../LockableContainer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { Loader2, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import {
  useIsKiloAdmin,
  useUserOrganizationRole,
} from '@/components/organizations/OrganizationContext';
import {
  useInviteMember,
  useOrganizationSeatUsage,
  useOrganizationWithMembers,
} from '@/app/api/organizations/hooks';
import { usePostHog } from 'posthog-js/react';
import { getLowerDomainFromEmail } from '@/lib/utils';

const emailSchema = z.email();

const ROLE_LABELS = {
  owner: 'Owner',
  member: 'Member',
  billing_manager: 'Billing Manager',
} as const;

// Business rules for inviting members:
// - Owners can invite anyone (owner, admin, member)
// - Admins can only invite admin or member (not owner)
// - Members cannot invite anyone (handled at component level)
const getAvailableInviteRoles = (
  currentUserRole: OrganizationRole,
  isKiloAdmin: boolean
): OrganizationRole[] => {
  // Kilo admin can invite anyone
  if (isKiloAdmin || currentUserRole === 'owner' || currentUserRole === 'billing_manager')
    return ['owner', 'member', 'billing_manager'];

  // Members cannot invite anyone
  return [];
};

type InviteMemberDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  onMemberInvited: () => void;
  blockClose?: boolean; // If true, prevents closing the dialog (hides close button and disables cancel)
};

export function InviteMemberDialog({
  open,
  onOpenChange,
  organizationId,
  onMemberInvited,
  blockClose = false,
}: InviteMemberDialogProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationRole>('member');
  const [isEmailFocused, setIsEmailFocused] = useState(false);
  const posthog = usePostHog();

  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();
  const { data: seatUsage } = useOrganizationSeatUsage(organizationId);
  const { data: organizationData } = useOrganizationWithMembers(organizationId);

  const availableRoles = useMemo(() => {
    return getAvailableInviteRoles(currentUserRole, isKiloAdmin);
  }, [currentUserRole, isKiloAdmin]);

  const isEmailValid = useMemo(() => {
    if (!email.trim()) return false;
    return emailSchema.safeParse(email.trim()).success;
  }, [email]);

  const emailDomainMatchesSSODomain = useMemo(() => {
    if (!email.trim() || !organizationData?.sso_domain) return false;
    const emailDomain = getLowerDomainFromEmail(email.trim());
    return emailDomain === organizationData.sso_domain.toLowerCase();
  }, [email, organizationData?.sso_domain]);

  const ssoErrorText = `Members of your enterprise domain (@${organizationData?.sso_domain}) should sign in to Kilo Code via your SSO IdP to be automatically added to this organization.`;

  const shouldShowEmailError = useMemo(() => {
    return email.trim() && !isEmailFocused && !isEmailValid;
  }, [email, isEmailFocused, isEmailValid]);

  const inviteMemberMutation = useInviteMember();

  // Calculate remaining seats
  const usedSeats = seatUsage?.usedSeats || 0;
  const totalSeats = seatUsage?.totalSeats || 0;
  const remainingSeats = totalSeats - usedSeats;
  const isOrgEnterprise = organizationData?.plan === 'enterprise';
  // Enterprise orgs have no seat-based invitation restrictions.
  // For Teams orgs, seat capacity only gates seat-consuming roles (not billing_manager).
  const seatCapacityAvailable = isOrgEnterprise || remainingSeats > 0;
  const isSeatConsumingRole = role !== 'billing_manager';
  const hasSeatsAvailable = seatCapacityAvailable || !isSeatConsumingRole;

  const handleInviteMember = () => {
    if (!email.trim()) {
      toast.error('Please enter an email address');
      return;
    }

    if (!isEmailValid) {
      toast.error('Please enter a valid email address');
      return;
    }

    if (emailDomainMatchesSSODomain) {
      toast.error(ssoErrorText);
      return;
    }

    inviteMemberMutation.mutate(
      {
        organizationId,
        email: email.trim(),
        role,
      },
      {
        onSuccess: () => {
          toast.success('Member invitation sent successfully');
          onMemberInvited();
          onOpenChange(false);
          handleReset();
          posthog?.capture('organization_member_invited', { organizationId, email, role });
        },
        onError: error => {
          toast.error(error instanceof Error ? error.message : 'Failed to invite member');
        },
      }
    );
  };

  const handleReset = () => {
    setEmail('');
    // Reset to the first available role, or 'member' if available
    const defaultRole = availableRoles.includes('member')
      ? 'member'
      : availableRoles[0] || 'member';
    setRole(defaultRole);
  };

  const handleClose = () => {
    // Prevent closing if blockClose is true
    if (blockClose) {
      return;
    }
    onOpenChange(false);
    handleReset();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <LockableContainer>
        <DialogContent className="sm:max-w-[600px]" showCloseButton={!blockClose}>
          <DialogHeader>
            <DialogTitle>Invite Member</DialogTitle>
            <DialogDescription className="text-pretty">
              Send an invitation to join this team. They will receive an email with instructions to
              join.
            </DialogDescription>
          </DialogHeader>

          <div className="grid py-2">
            <div className="flex items-start gap-4">
              <div className="flex-1 space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <div className="flex min-h-[60px] flex-col justify-start">
                  <Input
                    id="email"
                    type="email"
                    placeholder="Enter email address..."
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onFocus={() => setIsEmailFocused(true)}
                    onBlur={() => setIsEmailFocused(false)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        handleInviteMember();
                      }
                    }}
                    className={
                      shouldShowEmailError || emailDomainMatchesSSODomain
                        ? 'border-red-500 focus:border-red-500'
                        : ''
                    }
                    disabled={!hasSeatsAvailable}
                  />
                </div>
              </div>

              <div className="w-32 space-y-2">
                <Label htmlFor="role">Role</Label>
                <div className="flex min-h-[60px] flex-col justify-start">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex h-10 items-center justify-between gap-2 px-3"
                        disabled={inviteMemberMutation.isPending}
                      >
                        {ROLE_LABELS[role]}
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {(['owner', 'member', 'billing_manager'] as const).map(
                        (roleOption: OrganizationRole) => {
                          const isAvailable = availableRoles.includes(roleOption);
                          const isSelected = role === roleOption;

                          return (
                            <DropdownMenuItem
                              key={roleOption}
                              onClick={() => isAvailable && setRole(roleOption)}
                              disabled={inviteMemberMutation.isPending || !isAvailable}
                            >
                              {ROLE_LABELS[roleOption]}
                              {isSelected && (
                                <span className="text-muted-foreground ml-2">(selected)</span>
                              )}
                            </DropdownMenuItem>
                          );
                        }
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>

            {(shouldShowEmailError || emailDomainMatchesSSODomain) && (
              <div className="rounded-md border border-red-800 bg-red-950/30 p-3">
                <div className="flex items-center gap-2">
                  <svg
                    className="h-4 w-4 flex-shrink-0 text-red-400"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <p className="text-sm text-red-300" role="alert">
                    {shouldShowEmailError && 'Please enter a valid email address'}
                    {emailDomainMatchesSSODomain && ssoErrorText}
                  </p>
                </div>
              </div>
            )}

            {!seatCapacityAvailable && !isOrgEnterprise && (
              <div className="rounded-md border border-amber-800 bg-amber-950/30 p-3">
                <p className="text-sm text-amber-300">
                  All seats are in use ({usedSeats}/{totalSeats}). You can still invite billing
                  managers, who don&apos;t consume a seat.
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            {blockClose ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="inline-block">
                    <Button
                      variant="outline"
                      onClick={handleClose}
                      disabled={inviteMemberMutation.isPending || blockClose}
                    >
                      Cancel
                    </Button>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Invite someone to continue</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Button
                variant="outline"
                onClick={handleClose}
                disabled={inviteMemberMutation.isPending || blockClose}
              >
                Cancel
              </Button>
            )}
            <Button
              onClick={handleInviteMember}
              disabled={
                !isEmailValid ||
                emailDomainMatchesSSODomain ||
                inviteMemberMutation.isPending ||
                !hasSeatsAvailable
              }
            >
              {inviteMemberMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send Invitation
            </Button>
          </DialogFooter>
        </DialogContent>
      </LockableContainer>
    </Dialog>
  );
}
