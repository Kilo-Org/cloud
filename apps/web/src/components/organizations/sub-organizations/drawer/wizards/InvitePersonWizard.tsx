'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePostHog } from 'posthog-js/react';
import * as z from 'zod';
import { toast } from 'sonner';

import { useInviteMember } from '@/app/api/organizations/hooks';
import {
  useIsKiloAdmin,
  useUserOrganizationRole,
} from '@/components/organizations/OrganizationContext';
import { OrganizationAdminContextProvider } from '@/components/organizations/OrganizationContextWrapper';
import {
  getAvailableInviteRoles,
  INVITE_SUCCESS_MESSAGE,
  ROLE_LABELS,
} from '@/components/organizations/members/InviteMemberDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { captureWizardRun } from './wizardAnalytics';
import { WizardChrome } from './WizardChrome';

/**
 * A direct invite can only ever target the parent organization —
 * `inviteUserToOrganization` (`apps/web/src/lib/organizations/organizations.ts`)
 * unconditionally rejects any organization with a `parent_organization_id`
 * set, regardless of who's inviting, so there's no organization to choose
 * from and no picker step. This note preserves the discoverability an
 * earlier version of this wizard's now-removed org-picker step used to
 * provide: that sub-organization membership is a separate, later step,
 * done through the drawer entry with this exact header (see
 * `renderMemberManagementDrawerContent.tsx`).
 */
const SUB_ORGANIZATION_NOTE =
  'New people join the parent organization. Afterward, use "Add people to sub-organizations" to assign them to individual sub-organizations.';

const emailSchema = z.email();

export function InvitePersonWizard({
  parentOrganizationId,
  onClose,
}: {
  parentOrganizationId: string;
  onClose: () => void;
}) {
  return (
    <OrganizationAdminContextProvider organizationId={parentOrganizationId}>
      <InviteForm parentOrganizationId={parentOrganizationId} onClose={onClose} />
    </OrganizationAdminContextProvider>
  );
}

function InviteForm({
  parentOrganizationId,
  onClose,
}: {
  parentOrganizationId: string;
  onClose: () => void;
}) {
  const posthog = usePostHog();
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();
  const availableRoles = useMemo(
    () => getAvailableInviteRoles(currentUserRole, isKiloAdmin),
    [currentUserRole, isKiloAdmin]
  );
  const canInvite = availableRoles.length > 0;

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationRole>('member');
  const [isEmailFocused, setIsEmailFocused] = useState(false);

  // Resets to a role that's actually valid for the viewer, mirroring
  // `InviteMemberDialog`'s own reset behavior so this doesn't submit a role
  // the viewer isn't allowed to assign.
  useEffect(() => {
    if (availableRoles.length === 0) return;
    if (availableRoles.includes(role)) return;
    setRole(availableRoles.includes('member') ? 'member' : availableRoles[0]);
    // Only re-derive when the viewer's available roles change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableRoles]);

  const isEmailValid = useMemo(() => {
    if (!email.trim()) return false;
    return emailSchema.safeParse(email.trim()).success;
  }, [email]);
  const shouldShowEmailError = email.trim() && !isEmailFocused && !isEmailValid;

  const inviteMutation = useInviteMember();

  const handleInvite = () => {
    if (!canInvite) return;
    if (!isEmailValid) {
      toast.error('Please enter a valid email address');
      return;
    }

    inviteMutation.mutate(
      { organizationId: parentOrganizationId, email: email.trim(), role },
      {
        onSuccess: () => {
          toast.success(INVITE_SUCCESS_MESSAGE);
          posthog?.capture('sub_org_directory.person_invited', {
            parentOrganizationId,
            organizationId: parentOrganizationId,
            role,
          });
          // Also feeds the same `wizard_run` family the add/remove wizards
          // report through `useWizardRunTelemetry`, so a Phase 2 usage
          // dashboard built on `sub_org_directory.wizard_run` sees invite
          // runs too, instead of only bulk add/remove ones. There's no
          // batch here, so this fires directly rather than through the
          // batch-oriented `useWizardRunTelemetry` hook — one invite is one
          // run of exactly one row, targeting exactly one org.
          captureWizardRun(posthog, {
            parentOrganizationId,
            wizardType: 'invite',
            targetOrganizationIds: [parentOrganizationId],
            selectedPersonCount: 1,
          });
          onClose();
        },
        onError: error => {
          toast.error(error instanceof Error ? error.message : 'Failed to invite member');
        },
      }
    );
  };

  return (
    <WizardChrome stepTitle="Invite by email">
      <p className="text-muted-foreground text-sm">{SUB_ORGANIZATION_NOTE}</p>

      {!canInvite && (
        <p className="text-destructive text-sm">
          You don't have permission to invite members into this organization.
        </p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="invite-person-email">Email address</Label>
        <Input
          id="invite-person-email"
          type="email"
          placeholder="Enter email address…"
          value={email}
          onChange={event => setEmail(event.target.value)}
          onFocus={() => setIsEmailFocused(true)}
          onBlur={() => setIsEmailFocused(false)}
          onKeyDown={event => {
            if (event.key === 'Enter') handleInvite();
          }}
          className={shouldShowEmailError ? 'border-red-500 focus:border-red-500' : ''}
          disabled={!canInvite}
        />
        {shouldShowEmailError && (
          <p className="text-sm text-red-400" role="alert">
            Please enter a valid email address
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="invite-person-role">Role</Label>
        <Select value={role} onValueChange={value => setRole(value as OrganizationRole)}>
          <SelectTrigger id="invite-person-role" className="w-full" disabled={!canInvite}>
            <SelectValue />
          </SelectTrigger>
          {/* The drawer stack (`DrawerStack.tsx`) renders each layer's panel
              at `zIndex: 61 + ...`, above `Select`'s portaled content's
              default `z-50` — this override matches the one already
              established for a `Select` in this same drawer-stack family
              (`ModelAccessPolicyEditor.tsx`), so this dropdown paints above
              the drawer panel instead of invisibly behind it. */}
          <SelectContent className="z-[70]">
            {availableRoles.map(roleOption => (
              <SelectItem key={roleOption} value={roleOption}>
                {ROLE_LABELS[roleOption]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          onClick={handleInvite}
          disabled={!canInvite || !isEmailValid || inviteMutation.isPending}
        >
          Send invitation
        </Button>
      </div>
    </WizardChrome>
  );
}
