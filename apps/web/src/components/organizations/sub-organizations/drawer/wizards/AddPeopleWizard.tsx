'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePostHog } from 'posthog-js/react';

import { useInviteMember } from '@/app/api/organizations/hooks';
import {
  useIsKiloAdmin,
  useUserOrganizationRole,
} from '@/components/organizations/OrganizationContext';
import { OrganizationAdminContextProvider } from '@/components/organizations/OrganizationContextWrapper';
import {
  getAvailableInviteRoles,
  ROLE_LABELS,
} from '@/components/organizations/members/InviteMemberDialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import type { SubOrganizationPeopleData } from '../types';
import { addEligibilityLabel, computeAddEligibility, type Person } from './eligibility';
import { useRowExecutor } from './rowExecutor';
import { useWizardRunTelemetry } from './wizardAnalytics';
import { WizardChrome } from './WizardChrome';
import { WizardResultsList, type ResultRow } from './WizardResultsList';

type Child = SubOrganizationPeopleData['children'][number];
type Step = 'select' | 'target' | 'preview' | 'results';

/** One person invited into one target org — the executable unit of an add-people run. */
type AddPersonToOrgRow = { person: Person; organization: Child };

const STEP_TITLES: Record<Step, string> = {
  select: 'Step 1 of 4: Select people',
  target: 'Step 2 of 4: Pick target sub-organizations',
  preview: 'Step 3 of 4: Preview and choose a role',
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
  const [role, setRole] = useState<OrganizationRole>('member');

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

  // The role picker's options below reflect the acting user's permissions in
  // only the first selected target org, not every selected org — computing
  // an exact per-org intersection would need a separate org-membership fetch
  // just to populate a dropdown. If the picked role isn't actually valid in
  // a different selected org, that pair simply fails server-side and is
  // reported as an ordinary per-row failure in the results step, the same
  // way a seat-limit rejection is — see `rowExecutor.ts`.
  const primaryTargetOrganizationId = targetOrganizations[0]?.id ?? null;

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

      {(step === 'preview' || step === 'results') && primaryTargetOrganizationId && (
        <OrganizationAdminContextProvider organizationId={primaryTargetOrganizationId}>
          {step === 'preview' ? (
            <PreviewStep
              selectedPeople={selectedPeople}
              targetOrganizations={targetOrganizations}
              role={role}
              onChangeRole={setRole}
              onBack={() => setStep('target')}
              onConfirm={() => setStep('results')}
            />
          ) : (
            <AddResultsStep
              parentOrganizationId={parentOrganizationId}
              selectedPeople={selectedPeople}
              targetOrganizations={targetOrganizations}
              role={role}
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
      <ul className="divide-border max-h-96 divide-y overflow-y-auto rounded-md border">
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
      <ul className="divide-border max-h-96 divide-y overflow-y-auto rounded-md border">
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
  role,
  onChangeRole,
  onBack,
  onConfirm,
}: {
  selectedPeople: Person[];
  targetOrganizations: Child[];
  role: OrganizationRole;
  onChangeRole: (role: OrganizationRole) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const currentUserRole = useUserOrganizationRole();
  const isKiloAdmin = useIsKiloAdmin();
  const availableRoles = useMemo(
    () => getAvailableInviteRoles(currentUserRole, isKiloAdmin),
    [currentUserRole, isKiloAdmin]
  );
  const canInvite = availableRoles.length > 0;
  const eligibleCount = selectedPeople.reduce(
    (count, person) =>
      count +
      targetOrganizations.filter(
        organization => computeAddEligibility(person, organization.id).eligible
      ).length,
    0
  );

  return (
    <>
      {canInvite ? (
        <div className="space-y-1.5">
          <label className="text-sm font-medium" htmlFor="add-people-role">
            Role for all invited people
          </label>
          <Select value={role} onValueChange={value => onChangeRole(value as OrganizationRole)}>
            <SelectTrigger id="add-people-role" className="w-full">
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
      ) : (
        <p className="text-destructive text-sm">
          You don't have permission to invite members into the selected sub-organizations.
        </p>
      )}

      {/* Grouped by person, with each person's target orgs listed underneath —
          keeps each person's name/email from repeating once per org the way a
          flat (person, org) table would, and mirrors the results step's
          "person → org" framing below. */}
      <ul className="divide-border max-h-80 divide-y overflow-y-auto rounded-md border">
        {selectedPeople.map(person => (
          <li key={person.identityKey} className="px-3 py-2">
            <p className="truncate text-sm font-medium">{person.name}</p>
            <p className="text-muted-foreground truncate text-xs">{person.email}</p>
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
          </li>
        ))}
      </ul>

      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onConfirm} disabled={!canInvite || eligibleCount === 0}>
          Invite {eligibleCount} {eligibleCount === 1 ? 'invitation' : 'invitations'}
        </Button>
      </div>
    </>
  );
}

function AddResultsStep({
  parentOrganizationId,
  selectedPeople,
  targetOrganizations,
  role,
  onClose,
}: {
  parentOrganizationId: string;
  selectedPeople: Person[];
  targetOrganizations: Child[];
  role: OrganizationRole;
  onClose: () => void;
}) {
  const posthog = usePostHog();
  const inviteMutation = useInviteMember();

  // One row per (person, target org) pair — every selected person crossed
  // with every selected target org. `rowExecutor` runs this flat list
  // strictly sequentially regardless of which org each row targets: seats
  // are consumed per-org, but a global sequential run is still the safest
  // default and keeps a single, easy-to-follow progress/results list.
  const rows: AddPersonToOrgRow[] = useMemo(
    () =>
      selectedPeople.flatMap(person =>
        targetOrganizations.map(organization => ({ person, organization }))
      ),
    [selectedPeople, targetOrganizations]
  );

  const skip = useCallback(
    ({ person, organization }: AddPersonToOrgRow) => addEligibilityLabel(person, organization.id),
    []
  );

  const execute = useCallback(
    async ({ person, organization }: AddPersonToOrgRow) => {
      await inviteMutation.mutateAsync({
        organizationId: organization.id,
        email: person.email,
        role,
      });
    },
    [inviteMutation, role]
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

  const resultRows: ResultRow[] = rows.map(({ person, organization }) => ({
    key: `${person.identityKey}::${organization.id}`,
    label: person.name,
    sublabel: `${person.email} → ${organization.name}`,
  }));

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
