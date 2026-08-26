'use client';

import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePostHog } from 'posthog-js/react';

import { useDeleteOrganizationInvitation, useRemoveMember } from '@/app/api/organizations/hooks';
import {
  useIsKiloAdmin,
  useUserOrganizationRole,
} from '@/components/organizations/OrganizationContext';
import { OrganizationAdminContextProvider } from '@/components/organizations/OrganizationContextWrapper';
import {
  canActOnMemberRole,
  canManageMembers,
  canRemoveMember,
} from '@/components/organizations/OrganizationMembersCard';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import type { SubOrganizationPeopleData } from '../types';
import {
  personHasPresenceInOrganization,
  resolveRemoveTarget,
  type Person,
  type RemoveTarget,
} from './eligibility';
import { useRowExecutor } from './rowExecutor';
import { useWizardRunTelemetry } from './wizardAnalytics';
import { WizardChrome } from './WizardChrome';
import { WizardResultsList, type ResultRow } from './WizardResultsList';

type Child = SubOrganizationPeopleData['children'][number];
type Step = 'target' | 'select' | 'preview' | 'results';

const STEP_TITLES: Record<Step, string> = {
  target: 'Step 1 of 4: Pick target sub-organization',
  select: 'Step 2 of 4: Select people',
  preview: 'Step 3 of 4: Preview and confirm',
  results: 'Step 4 of 4: Results',
};

/**
 * Human-readable reason `target` can't be removed, or `null` if it can.
 * Shared by the preview step (disabled row label) and results step (`skip`
 * reason) so those two can't drift into showing different text — or
 * different permission verdicts — for the same row.
 */
function removeDisabledReason(
  target: RemoveTarget | null,
  params: { currentUserRole: OrganizationRole; isKiloAdmin: boolean; isCurrentUser: boolean }
): string | null {
  if (!target) return 'No longer present in this sub-organization';
  const { currentUserRole, isKiloAdmin, isCurrentUser } = params;
  if (target.kind === 'membership') {
    return canRemoveMember(currentUserRole, isKiloAdmin, isCurrentUser, target.role)
      ? null
      : 'You cannot remove an owner';
  }
  return canManageMembers(currentUserRole, isKiloAdmin) &&
    canActOnMemberRole(currentUserRole, isKiloAdmin, target.role)
    ? null
    : 'You cannot revoke an owner invitation';
}

export function RemovePeopleWizard({
  parentOrganizationId,
  people,
  children,
  seededIdentityKeys,
  onClose,
}: {
  parentOrganizationId: string;
  people: SubOrganizationPeopleData['people'];
  children: Child[];
  seededIdentityKeys: string[];
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>('target');
  const [targetOrganizationId, setTargetOrganizationId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(seededIdentityKeys));

  const eligiblePeople = useMemo(
    () =>
      targetOrganizationId
        ? people.filter(person => personHasPresenceInOrganization(person, targetOrganizationId))
        : [],
    [people, targetOrganizationId]
  );

  // A previously seeded selection may include people with no presence in
  // whichever target the user ends up picking; drop those rather than
  // carrying a selection the select-people step can't display.
  useEffect(() => {
    if (!targetOrganizationId) return;
    const eligibleKeys = new Set(eligiblePeople.map(person => person.identityKey));
    setSelected(previous => {
      const next = new Set([...previous].filter(key => eligibleKeys.has(key)));
      return next.size === previous.size ? previous : next;
    });
    // Only re-derive when the target (and therefore `eligiblePeople`) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetOrganizationId]);

  const selectedPeople = useMemo(
    () => eligiblePeople.filter(person => selected.has(person.identityKey)),
    [eligiblePeople, selected]
  );

  const toggle = useCallback((identityKey: string, checked: boolean) => {
    setSelected(previous => {
      const next = new Set(previous);
      if (checked) next.add(identityKey);
      else next.delete(identityKey);
      return next;
    });
  }, []);

  return (
    <WizardChrome stepTitle={STEP_TITLES[step]}>
      {step === 'target' && (
        <TargetStep
          children={children}
          targetOrganizationId={targetOrganizationId}
          onChangeTarget={setTargetOrganizationId}
          onNext={() => setStep('select')}
        />
      )}

      {step !== 'target' && targetOrganizationId && (
        <OrganizationAdminContextProvider organizationId={targetOrganizationId}>
          {step === 'select' && (
            <SelectPeopleStep
              people={eligiblePeople}
              selected={selected}
              onToggle={toggle}
              onBack={() => setStep('target')}
              onNext={() => setStep('preview')}
            />
          )}
          {step === 'preview' && (
            <PreviewStep
              selectedPeople={selectedPeople}
              targetOrganizationId={targetOrganizationId}
              onBack={() => setStep('select')}
              onConfirm={() => setStep('results')}
            />
          )}
          {step === 'results' && (
            <RemoveResultsStep
              parentOrganizationId={parentOrganizationId}
              selectedPeople={selectedPeople}
              targetOrganizationId={targetOrganizationId}
              onClose={onClose}
            />
          )}
        </OrganizationAdminContextProvider>
      )}
    </WizardChrome>
  );
}

function TargetStep({
  children,
  targetOrganizationId,
  onChangeTarget,
  onNext,
}: {
  children: Child[];
  targetOrganizationId: string | null;
  onChangeTarget: (id: string) => void;
  onNext: () => void;
}) {
  return (
    <>
      <RadioGroup value={targetOrganizationId ?? undefined} onValueChange={onChangeTarget}>
        {children.map(child => (
          <label
            key={child.id}
            htmlFor={`remove-people-target-${child.id}`}
            className="hover:bg-surface-hover flex items-center gap-3 rounded-md border px-3 py-2"
          >
            <RadioGroupItem value={child.id} id={`remove-people-target-${child.id}`} />
            <span className="text-sm">{child.name}</span>
          </label>
        ))}
        {children.length === 0 && (
          <p className="text-muted-foreground text-sm">No sub-organizations available.</p>
        )}
      </RadioGroup>
      <div className="flex justify-end gap-2">
        <Button onClick={onNext} disabled={!targetOrganizationId}>
          Next
        </Button>
      </div>
    </>
  );
}

function SelectPeopleStep({
  people,
  selected,
  onToggle,
  onBack,
  onNext,
}: {
  people: Person[];
  selected: Set<string>;
  onToggle: (identityKey: string, checked: boolean) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <ul className="divide-border flex-1 min-h-0 divide-y overflow-y-auto rounded-md border">
        {people.map(person => (
          <li key={person.identityKey} className="flex items-center gap-3 px-3 py-2">
            <Checkbox
              aria-label={`Select ${person.name || person.email}`}
              checked={selected.has(person.identityKey)}
              onCheckedChange={checked => onToggle(person.identityKey, Boolean(checked))}
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{person.name}</p>
              <p className="text-muted-foreground truncate text-xs">{person.email}</p>
            </div>
          </li>
        ))}
        {people.length === 0 && (
          <li className="text-muted-foreground px-3 py-6 text-center text-sm">
            No people in this sub-organization to remove.
          </li>
        )}
      </ul>
      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext} disabled={selected.size === 0}>
          Next ({selected.size} selected)
        </Button>
      </div>
    </>
  );
}

function PreviewStep({
  selectedPeople,
  targetOrganizationId,
  onBack,
  onConfirm,
}: {
  selectedPeople: Person[];
  targetOrganizationId: string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();
  const session = useSession();
  const kiloUserId = session?.data?.user?.id;
  const kiloUserEmail = session?.data?.user?.email;

  const rows = selectedPeople.map(person => {
    const target = resolveRemoveTarget(person, targetOrganizationId);
    const isCurrentUser = person.kiloUserId === kiloUserId || person.email === kiloUserEmail;
    const disabledReason = removeDisabledReason(target, {
      currentUserRole,
      isKiloAdmin,
      isCurrentUser,
    });
    return { person, target, disabledReason };
  });
  const removableCount = rows.filter(row => row.disabledReason === null).length;

  return (
    <>
      <p className="text-destructive text-sm">
        This removes each person's membership or pending invitation from this sub-organization. This
        cannot be undone — they will need a new invitation to rejoin.
      </p>

      <ul className="divide-border flex-1 min-h-0 divide-y overflow-y-auto rounded-md border">
        {rows.map(({ person, target, disabledReason }) => (
          <li
            key={person.identityKey}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{person.name}</p>
              <p className="text-muted-foreground truncate text-xs">
                {person.email}
                {target ? ` · ${target.role.replace('_', ' ')}` : ''}
              </p>
            </div>
            {disabledReason && (
              <span className="text-muted-foreground text-xs whitespace-nowrap">
                {disabledReason}
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <InlineDeleteConfirmation
          showAsButton
          disabled={removableCount === 0}
          onDelete={onConfirm}
          buttonText={`Remove ${removableCount} ${removableCount === 1 ? 'person' : 'people'}`}
          warningText="This cannot be undone."
        />
      </div>
    </>
  );
}

function RemoveResultsStep({
  parentOrganizationId,
  selectedPeople,
  targetOrganizationId,
  onClose,
}: {
  parentOrganizationId: string;
  selectedPeople: Person[];
  targetOrganizationId: string;
  onClose: () => void;
}) {
  const posthog = usePostHog();
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();
  const session = useSession();
  const kiloUserId = session?.data?.user?.id;
  const kiloUserEmail = session?.data?.user?.email;
  const removeMutation = useRemoveMember();
  const deleteInviteMutation = useDeleteOrganizationInvitation();

  const skip = useCallback(
    (person: Person) => {
      const target = resolveRemoveTarget(person, targetOrganizationId);
      const isCurrentUser = person.kiloUserId === kiloUserId || person.email === kiloUserEmail;
      return removeDisabledReason(target, { currentUserRole, isKiloAdmin, isCurrentUser });
    },
    [targetOrganizationId, currentUserRole, isKiloAdmin, kiloUserId, kiloUserEmail]
  );

  const execute = useCallback(
    async (person: Person) => {
      const target = resolveRemoveTarget(person, targetOrganizationId);
      if (!target) {
        throw new Error('No longer present in this sub-organization');
      }
      if (target.kind === 'membership') {
        if (!person.kiloUserId) {
          throw new Error('Missing user id for an accepted member');
        }
        await removeMutation.mutateAsync({
          organizationId: targetOrganizationId,
          memberId: person.kiloUserId,
        });
      } else {
        await deleteInviteMutation.mutateAsync({
          organizationId: targetOrganizationId,
          inviteId: target.inviteId,
        });
      }
    },
    [targetOrganizationId, removeMutation, deleteInviteMutation]
  );

  const { outcomes, isRunning, progress, start, retryFailed } = useRowExecutor(
    selectedPeople,
    skip,
    execute
  );

  useWizardRunTelemetry({
    posthog,
    parentOrganizationId,
    wizardType: 'remove',
    targetOrganizationIds: [targetOrganizationId],
    selectedPersonCount: selectedPeople.length,
    start,
    isRunning,
    outcomes,
  });

  const rows: ResultRow[] = selectedPeople.map(person => ({
    key: person.identityKey,
    label: person.name,
    sublabel: person.email,
  }));

  return (
    <WizardResultsList
      rows={rows}
      outcomes={outcomes}
      isRunning={isRunning}
      progress={progress}
      onRetryFailed={retryFailed}
      onClose={onClose}
    />
  );
}
