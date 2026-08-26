'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePostHog } from 'posthog-js/react';

import { useSetChildMemberships } from '@/app/api/organizations/hooks';
import {
  useIsKiloAdmin,
  useUserOrganizationRole,
} from '@/components/organizations/OrganizationContext';
import { OrganizationAdminContextProvider } from '@/components/organizations/OrganizationContextWrapper';
import { canInviteMembers } from '@/components/organizations/OrganizationMembersCard';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import type { SubOrganizationPeopleData } from '../types';
import {
  addEligibilityLabel,
  desiredChildOrganizationIds,
  eligibleAddTargetOrganizationIds,
  personCanBeAddedToChildOrganizations,
  type Person,
} from './eligibility';
import { useRowExecutor } from './rowExecutor';
import { useWizardRunTelemetry } from './wizardAnalytics';
import { WizardChrome } from './WizardChrome';
import { WizardResultsList, type ResultRow } from './WizardResultsList';

type Child = SubOrganizationPeopleData['children'][number];
type Step = 'select' | 'target' | 'preview' | 'results';

/**
 * One person, and which of the selected target orgs they'll actually be
 * added to — the executable unit of an add-people run. `setChildMemberships`
 * takes one call per person with that person's full desired child-org set,
 * not one call per (person, org) pair, so a row is per-person here too.
 */
type AddPersonRow = { person: Person; eligibleTargetOrganizationIds: string[] };

const STEP_TITLES: Record<Step, string> = {
  select: 'Step 1 of 4: Select people',
  target: 'Step 2 of 4: Pick target sub-organizations',
  preview: 'Step 3 of 4: Preview and confirm',
  results: 'Step 4 of 4: Results',
};

export function AddPeopleWizard({
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
  const [step, setStep] = useState<Step>('select');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(seededIdentityKeys));
  const [search, setSearch] = useState('');
  const [targetOrganizationIds, setTargetOrganizationIds] = useState<Set<string>>(() => new Set());

  const selectedPeople = useMemo(
    () => people.filter(person => selected.has(person.identityKey)),
    [people, selected]
  );

  const targetOrganizations = useMemo(
    () => children.filter(child => targetOrganizationIds.has(child.id)),
    [children, targetOrganizationIds]
  );

  const filteredPeople = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return people;
    return people.filter(
      person =>
        person.name.toLowerCase().includes(term) || person.email.toLowerCase().includes(term)
    );
  }, [people, search]);

  const toggle = useCallback((identityKey: string, checked: boolean) => {
    setSelected(previous => {
      const next = new Set(previous);
      if (checked) next.add(identityKey);
      else next.delete(identityKey);
      return next;
    });
  }, []);

  const toggleTarget = useCallback((organizationId: string, checked: boolean) => {
    setTargetOrganizationIds(previous => {
      const next = new Set(previous);
      if (checked) next.add(organizationId);
      else next.delete(organizationId);
      return next;
    });
  }, []);

  return (
    <WizardChrome stepTitle={STEP_TITLES[step]}>
      {step === 'select' && (
        <SelectPeopleStep
          people={filteredPeople}
          selected={selected}
          onToggle={toggle}
          search={search}
          onSearchChange={setSearch}
          onNext={() => setStep('target')}
        />
      )}

      {step === 'target' && (
        <TargetStep
          children={children}
          targetOrganizationIds={targetOrganizationIds}
          onToggleTarget={toggleTarget}
          onBack={() => setStep('select')}
          onNext={() => setStep('preview')}
        />
      )}

      {/* `setChildMemberships`'s permission check is against the PARENT
          org (owner/billing_manager), not any of the selected child target
          orgs, unlike the old per-child-org `invite` call this replaced —
          so this context is scoped to `parentOrganizationId`, not a target
          org, for both the preview permission precheck and the results
          step's mutation call. */}
      {(step === 'preview' || step === 'results') && (
        <OrganizationAdminContextProvider organizationId={parentOrganizationId}>
          {step === 'preview' ? (
            <PreviewStep
              selectedPeople={selectedPeople}
              targetOrganizations={targetOrganizations}
              onBack={() => setStep('target')}
              onConfirm={() => setStep('results')}
            />
          ) : (
            <AddResultsStep
              parentOrganizationId={parentOrganizationId}
              selectedPeople={selectedPeople}
              targetOrganizations={targetOrganizations}
              onClose={onClose}
            />
          )}
        </OrganizationAdminContextProvider>
      )}
    </WizardChrome>
  );
}

function SelectPeopleStep({
  people,
  selected,
  onToggle,
  search,
  onSearchChange,
  onNext,
}: {
  people: Person[];
  selected: Set<string>;
  onToggle: (identityKey: string, checked: boolean) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onNext: () => void;
}) {
  return (
    <>
      <Input
        placeholder="Search people"
        value={search}
        onChange={event => onSearchChange(event.target.value)}
      />
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
            No people match your search.
          </li>
        )}
      </ul>
      <div className="flex justify-end gap-2">
        <Button onClick={onNext} disabled={selected.size === 0}>
          Next ({selected.size} selected)
        </Button>
      </div>
    </>
  );
}

function TargetStep({
  children,
  targetOrganizationIds,
  onToggleTarget,
  onBack,
  onNext,
}: {
  children: Child[];
  targetOrganizationIds: Set<string>;
  onToggleTarget: (id: string, checked: boolean) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <ul className="divide-border flex-1 min-h-0 divide-y overflow-y-auto rounded-md border">
        {children.map(child => (
          <li key={child.id} className="flex items-center gap-3 px-3 py-2">
            <Checkbox
              aria-label={`Select ${child.name}`}
              checked={targetOrganizationIds.has(child.id)}
              onCheckedChange={checked => onToggleTarget(child.id, Boolean(checked))}
            />
            <span className="text-sm">{child.name}</span>
          </li>
        ))}
        {children.length === 0 && (
          <li className="text-muted-foreground px-3 py-6 text-center text-sm">
            No sub-organizations available.
          </li>
        )}
      </ul>
      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext} disabled={targetOrganizationIds.size === 0}>
          Next ({targetOrganizationIds.size} selected)
        </Button>
      </div>
    </>
  );
}

function PreviewStep({
  selectedPeople,
  targetOrganizations,
  onBack,
  onConfirm,
}: {
  selectedPeople: Person[];
  targetOrganizations: Child[];
  onBack: () => void;
  onConfirm: () => void;
}) {
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();
  // Mirrors `ChildTeamsControl`'s own edit-affordance gate exactly (see
  // `canInviteMembers`'s comment) rather than the stricter owner/
  // billing_manager check `setChildMemberships` enforces server-side, so
  // this precheck and that existing control never disagree about who can
  // try. A caller who fails the server's stricter check still gets an
  // ordinary per-row failure in the results step.
  const canAddToChildOrganizations = canInviteMembers(currentUserRole, isKiloAdmin);

  const addableCount = selectedPeople.filter(
    person =>
      personCanBeAddedToChildOrganizations(person) &&
      eligibleAddTargetOrganizationIds(
        person,
        targetOrganizations.map(organization => organization.id)
      ).length > 0
  ).length;

  return (
    <>
      {!canAddToChildOrganizations && (
        <p className="text-destructive text-sm">
          You don't have permission to add members into the selected sub-organizations.
        </p>
      )}

      {/* Grouped by person, with each person's target orgs listed underneath —
          keeps each person's name/email from repeating once per org the way a
          flat (person, org) table would, and mirrors the results step's
          "person → org" framing below. A person who fails the whole-person
          `setChildMemberships` precondition is flagged once, without a
          per-org breakdown, since no selection of target orgs changes their
          outcome. */}
      <ul className="divide-border flex-1 min-h-0 divide-y overflow-y-auto rounded-md border">
        {selectedPeople.map(person => {
          const isParentMember = personCanBeAddedToChildOrganizations(person);
          return (
            <li key={person.identityKey} className="px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{person.name}</p>
                  <p className="text-muted-foreground truncate text-xs">{person.email}</p>
                </div>
                {!isParentMember && (
                  <span className="text-muted-foreground whitespace-nowrap text-xs">
                    Must be a member of the parent organization first
                  </span>
                )}
              </div>
              {isParentMember && (
                <ul className="mt-1.5 space-y-1">
                  {targetOrganizations.map(organization => {
                    const disabledLabel = addEligibilityLabel(person, organization.id);
                    return (
                      <li
                        key={organization.id}
                        className="flex items-center justify-between gap-3 pl-1 text-xs"
                      >
                        <span className="text-muted-foreground truncate">{organization.name}</span>
                        {disabledLabel && (
                          <span className="text-muted-foreground whitespace-nowrap">
                            {disabledLabel}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onConfirm} disabled={!canAddToChildOrganizations || addableCount === 0}>
          Add {addableCount} {addableCount === 1 ? 'person' : 'people'}
        </Button>
      </div>
    </>
  );
}

function AddResultsStep({
  parentOrganizationId,
  selectedPeople,
  targetOrganizations,
  onClose,
}: {
  parentOrganizationId: string;
  selectedPeople: Person[];
  targetOrganizations: Child[];
  onClose: () => void;
}) {
  const posthog = usePostHog();
  const setChildMembershipsMutation = useSetChildMemberships();

  // One row per PERSON — `setChildMemberships` takes one call per person
  // with that person's full desired child-org set, not one call per
  // (person, target org) pair.
  const rows: AddPersonRow[] = useMemo(
    () =>
      selectedPeople.map(person => ({
        person,
        eligibleTargetOrganizationIds: personCanBeAddedToChildOrganizations(person)
          ? eligibleAddTargetOrganizationIds(
              person,
              targetOrganizations.map(organization => organization.id)
            )
          : [],
      })),
    [selectedPeople, targetOrganizations]
  );

  const skip = useCallback(({ person, eligibleTargetOrganizationIds }: AddPersonRow) => {
    if (!personCanBeAddedToChildOrganizations(person)) {
      return 'Must be a member of the parent organization first';
    }
    if (eligibleTargetOrganizationIds.length === 0) {
      return 'Already a member of every selected sub-organization';
    }
    return null;
  }, []);

  const execute = useCallback(
    async ({ person, eligibleTargetOrganizationIds }: AddPersonRow) => {
      // `skip` above already guarantees there's at least one new target org
      // for any row that reaches here, which in turn requires `kiloUserId`
      // to be set (see `personCanBeAddedToChildOrganizations`).
      if (!person.kiloUserId) {
        throw new Error('Missing user id for an accepted parent organization member');
      }
      await setChildMembershipsMutation.mutateAsync({
        organizationId: parentOrganizationId,
        memberId: person.kiloUserId,
        childOrganizationIds: desiredChildOrganizationIds(person, eligibleTargetOrganizationIds),
      });
    },
    [setChildMembershipsMutation, parentOrganizationId]
  );

  const { outcomes, isRunning, progress, start, retryFailed } = useRowExecutor(rows, skip, execute);

  // This step only mounts when the wizard transitions into the results
  // step, so the mount/completion telemetry lifecycle below also kicks off
  // the batch (via `start`) at the right (and only) time.
  useWizardRunTelemetry({
    posthog,
    parentOrganizationId,
    wizardType: 'add',
    targetOrganizationIds: targetOrganizations.map(organization => organization.id),
    selectedPersonCount: selectedPeople.length,
    start,
    isRunning,
    outcomes,
  });

  const targetOrganizationNamesById = new Map(
    targetOrganizations.map(organization => [organization.id, organization.name])
  );
  const resultRows: ResultRow[] = rows.map(({ person, eligibleTargetOrganizationIds }) => {
    const addedToNames = eligibleTargetOrganizationIds.map(
      organizationId => targetOrganizationNamesById.get(organizationId) ?? organizationId
    );
    return {
      key: person.identityKey,
      label: person.name,
      sublabel:
        addedToNames.length > 0 ? `${person.email} → ${addedToNames.join(', ')}` : person.email,
    };
  });

  return (
    <WizardResultsList
      rows={resultRows}
      outcomes={outcomes}
      isRunning={isRunning}
      progress={progress}
      onRetryFailed={retryFailed}
      onClose={onClose}
    />
  );
}
