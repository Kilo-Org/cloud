'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePostHog } from 'posthog-js/react';
import * as z from 'zod';
import { toast } from 'sonner';

import { useInviteMember, useOrganizationWithMembers } from '@/app/api/organizations/hooks';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import type { SubOrganizationPeopleData } from '../types';
import { captureWizardRun } from './wizardAnalytics';
import { WizardChrome } from './WizardChrome';

type Child = SubOrganizationPeopleData['children'][number];
type Step = 'target' | 'invite';

/**
 * The parent org has no real display name available from the already-loaded
 * people directory (`organizations.subOrganizations.people` never fetches
 * it — the parent is a fixed row in the People page's own header, not part
 * of `data.children`). This label matches the placeholder the People
 * directory's backend already uses for the parent in invitation rows (see
 * `organization-sub-organizations-router.ts`), so this picker doesn't
 * introduce a second, differently-worded name for the same organization.
 */
export const PARENT_ORGANIZATION_LABEL = 'Parent organization';

type OrgOption = { id: string; name: string };

const STEP_TITLES: Record<Step, string> = {
  target: 'Step 1 of 2: Choose an organization',
  invite: 'Step 2 of 2: Invite by email',
};

const emailSchema = z.email();

/**
 * Reports whether the viewer can invite into `organizationId`, and with
 * which roles, by mounting the same real per-org role context the
 * manage-members drawer and the other bulk wizards use — rather than a
 * dedicated access-check endpoint. Mounted once per candidate organization
 * (parent + every direct child) so the target step can disable ones the
 * viewer can't use *before* they're picked, which the existing wizards
 * never needed since they only ever resolve access for an org once it's
 * already selected.
 */
function OrgAccessReporter({
  organizationId,
  onResult,
}: {
  organizationId: string;
  onResult: (organizationId: string, availableRoles: OrganizationRole[]) => void;
}) {
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();
  const availableRoles = useMemo(
    () => getAvailableInviteRoles(currentUserRole, isKiloAdmin),
    [currentUserRole, isKiloAdmin]
  );

  // `OrganizationAdminContextProvider` falls back to a `member` role (i.e.
  // no invite roles) while its own `useOrganizationWithMembers` fetch is
  // still in flight — the same fallback it uses if the viewer genuinely
  // has no access. Without checking the fetch's own loading state here too,
  // that fallback gets reported as the final answer, which would render an
  // org the viewer can actually invite into as "You can't invite here"
  // until the fetch resolves, instead of "Checking access…". A Kilo admin's
  // access doesn't come from this fetch at all, so it's reported immediately.
  const { isLoading } = useOrganizationWithMembers(organizationId);

  useEffect(() => {
    if (isLoading && !isKiloAdmin) return;
    onResult(organizationId, availableRoles);
  }, [organizationId, availableRoles, onResult, isLoading, isKiloAdmin]);

  return null;
}

function OrgAccessProbe({
  organizationId,
  onResult,
}: {
  organizationId: string;
  onResult: (organizationId: string, availableRoles: OrganizationRole[]) => void;
}) {
  return (
    <OrganizationAdminContextProvider organizationId={organizationId}>
      <OrgAccessReporter organizationId={organizationId} onResult={onResult} />
    </OrganizationAdminContextProvider>
  );
}

export function InvitePersonWizard({
  parentOrganizationId,
  children,
  onClose,
}: {
  parentOrganizationId: string;
  children: Child[];
  onClose: () => void;
}) {
  const posthog = usePostHog();
  const [step, setStep] = useState<Step>('target');
  const [targetOrganizationId, setTargetOrganizationId] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationRole>('member');
  const [isEmailFocused, setIsEmailFocused] = useState(false);
  const [accessByOrg, setAccessByOrg] = useState<Map<string, OrganizationRole[]>>(new Map());

  const orgOptions = useMemo<OrgOption[]>(
    () => [
      { id: parentOrganizationId, name: PARENT_ORGANIZATION_LABEL },
      ...children.map(child => ({ id: child.id, name: child.name })),
    ],
    [parentOrganizationId, children]
  );

  const handleAccessResult = useCallback(
    (organizationId: string, availableRoles: OrganizationRole[]) => {
      setAccessByOrg(previous => {
        if (previous.get(organizationId) === availableRoles) return previous;
        const next = new Map(previous);
        next.set(organizationId, availableRoles);
        return next;
      });
    },
    []
  );

  const availableRolesForTarget = targetOrganizationId
    ? (accessByOrg.get(targetOrganizationId) ?? [])
    : [];
  const canInviteIntoTarget = availableRolesForTarget.length > 0;

  const isEmailValid = useMemo(() => {
    if (!email.trim()) return false;
    return emailSchema.safeParse(email.trim()).success;
  }, [email]);
  const shouldShowEmailError = email.trim() && !isEmailFocused && !isEmailValid;

  const inviteMutation = useInviteMember();

  const handleChangeTarget = useCallback((organizationId: string) => {
    setTargetOrganizationId(organizationId);
  }, []);

  // The role picker resets to a role that's actually valid for whichever
  // target was picked, mirroring `InviteMemberDialog`'s own reset-on-target
  // behavior so this doesn't submit a role the target org doesn't allow.
  useEffect(() => {
    if (availableRolesForTarget.length === 0) return;
    if (availableRolesForTarget.includes(role)) return;
    setRole(availableRolesForTarget.includes('member') ? 'member' : availableRolesForTarget[0]);
    // Only re-derive when the available roles for the current target change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableRolesForTarget]);

  const handleInvite = () => {
    if (!targetOrganizationId || !canInviteIntoTarget) return;
    if (!isEmailValid) {
      toast.error('Please enter a valid email address');
      return;
    }

    inviteMutation.mutate(
      { organizationId: targetOrganizationId, email: email.trim(), role },
      {
        onSuccess: () => {
          toast.success(INVITE_SUCCESS_MESSAGE);
          posthog?.capture('sub_org_directory.person_invited', {
            parentOrganizationId,
            organizationId: targetOrganizationId,
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
            targetOrganizationIds: [targetOrganizationId],
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
    <>
      {orgOptions.map(option => (
        <OrgAccessProbe key={option.id} organizationId={option.id} onResult={handleAccessResult} />
      ))}

      <WizardChrome stepTitle={STEP_TITLES[step]}>
        {step === 'target' && (
          <TargetStep
            orgOptions={orgOptions}
            accessByOrg={accessByOrg}
            targetOrganizationId={targetOrganizationId}
            onChangeTarget={handleChangeTarget}
            onNext={() => setStep('invite')}
          />
        )}

        {step === 'invite' && targetOrganizationId && (
          <InviteStep
            email={email}
            onEmailChange={setEmail}
            onEmailFocus={() => setIsEmailFocused(true)}
            onEmailBlur={() => setIsEmailFocused(false)}
            isEmailValid={isEmailValid}
            shouldShowEmailError={Boolean(shouldShowEmailError)}
            role={role}
            onRoleChange={setRole}
            availableRoles={availableRolesForTarget}
            canInvite={canInviteIntoTarget}
            isPending={inviteMutation.isPending}
            onBack={() => setStep('target')}
            onSubmit={handleInvite}
          />
        )}
      </WizardChrome>
    </>
  );
}

function TargetStep({
  orgOptions,
  accessByOrg,
  targetOrganizationId,
  onChangeTarget,
  onNext,
}: {
  orgOptions: OrgOption[];
  accessByOrg: Map<string, OrganizationRole[]>;
  targetOrganizationId: string | null;
  onChangeTarget: (organizationId: string) => void;
  onNext: () => void;
}) {
  const canInviteIntoTarget = targetOrganizationId
    ? (accessByOrg.get(targetOrganizationId)?.length ?? 0) > 0
    : false;

  return (
    <>
      <RadioGroup value={targetOrganizationId ?? undefined} onValueChange={onChangeTarget}>
        {orgOptions.map(option => {
          const availableRoles = accessByOrg.get(option.id);
          const isLoadingAccess = availableRoles === undefined;
          const canInvite = (availableRoles?.length ?? 0) > 0;
          const disabled = !canInvite;
          return (
            <div
              key={option.id}
              className="hover:bg-surface-hover flex items-center justify-between gap-3 rounded-md border px-3 py-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              aria-disabled={disabled}
            >
              {/* Only the org name is inside the label, so the radio's
                  accessible name stays just the org name — the disabled
                  reason (rendered outside the label) would otherwise get
                  folded into it. */}
              <label
                htmlFor={`invite-person-target-${option.id}`}
                className="flex items-center gap-3"
              >
                <RadioGroupItem
                  value={option.id}
                  id={`invite-person-target-${option.id}`}
                  disabled={disabled}
                />
                <span className="text-sm">{option.name}</span>
              </label>
              {!canInvite && (
                <span className="text-muted-foreground text-xs whitespace-nowrap">
                  {isLoadingAccess ? 'Checking access…' : "You can't invite here"}
                </span>
              )}
            </div>
          );
        })}
      </RadioGroup>
      <div className="flex justify-end gap-2">
        <Button onClick={onNext} disabled={!targetOrganizationId || !canInviteIntoTarget}>
          Next
        </Button>
      </div>
    </>
  );
}

function InviteStep({
  email,
  onEmailChange,
  onEmailFocus,
  onEmailBlur,
  isEmailValid,
  shouldShowEmailError,
  role,
  onRoleChange,
  availableRoles,
  canInvite,
  isPending,
  onBack,
  onSubmit,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  onEmailFocus: () => void;
  onEmailBlur: () => void;
  isEmailValid: boolean;
  shouldShowEmailError: boolean;
  role: OrganizationRole;
  onRoleChange: (role: OrganizationRole) => void;
  availableRoles: OrganizationRole[];
  canInvite: boolean;
  isPending: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <>
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
          onChange={event => onEmailChange(event.target.value)}
          onFocus={onEmailFocus}
          onBlur={onEmailBlur}
          onKeyDown={event => {
            if (event.key === 'Enter') onSubmit();
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
        <Select value={role} onValueChange={value => onRoleChange(value as OrganizationRole)}>
          <SelectTrigger id="invite-person-role" className="w-full" disabled={!canInvite}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableRoles.map(roleOption => (
              <SelectItem key={roleOption} value={roleOption}>
                {ROLE_LABELS[roleOption]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={onBack} disabled={isPending}>
          Back
        </Button>
        <Button onClick={onSubmit} disabled={!canInvite || !isEmailValid || isPending}>
          Send invitation
        </Button>
      </div>
    </>
  );
}
