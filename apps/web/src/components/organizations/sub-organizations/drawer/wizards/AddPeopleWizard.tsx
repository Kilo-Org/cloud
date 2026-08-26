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
import { addEligibilityLabel, computeAddEligibility, type Person } from './eligibility';
import { useRowExecutor } from './rowExecutor';
import { useWizardRunTelemetry } from './wizardAnalytics';
import { WizardResultsList, type ResultRow } from './WizardResultsList';

type Child = SubOrganizationPeopleData['children'][number];
type Step = 'select' | 'target' | 'preview' | 'results';

const STEP_TITLES: Record<Step, string> = {
  select: 'Step 1 of 4: Select people',
  target: 'Step 2 of 4: Pick target sub-organization',
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
  const [targetOrganizationId, setTargetOrganizationId] = useState<string | null>(null);
  const [role, setRole] = useState<OrganizationRole>('member');

  const selectedPeople = useMemo(
    () => people.filter(person => selected.has(person.identityKey)),
    [people, selected]
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

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {STEP_TITLES[step]}
      </p>

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
          targetOrganizationId={targetOrganizationId}
          onChangeTarget={setTargetOrganizationId}
          onBack={() => setStep('select')}
          onNext={() => setStep('preview')}
        />
      )}

      {(step === 'preview' || step === 'results') && targetOrganizationId && (
        <OrganizationAdminContextProvider organizationId={targetOrganizationId}>
          {step === 'preview' ? (
            <PreviewStep
              selectedPeople={selectedPeople}
              targetOrganizationId={targetOrganizationId}
              role={role}
              onChangeRole={setRole}
              onBack={() => setStep('target')}
              onConfirm={() => setStep('results')}
            />
          ) : (
            <AddResultsStep
              parentOrganizationId={parentOrganizationId}
              selectedPeople={selectedPeople}
              targetOrganizationId={targetOrganizationId}
              role={role}
              onClose={onClose}
            />
          )}
        </OrganizationAdminContextProvider>
      )}
    </div>
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
  targetOrganizationId,
  onChangeTarget,
  onBack,
  onNext,
}: {
  children: Child[];
  targetOrganizationId: string | null;
  onChangeTarget: (id: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <RadioGroup value={targetOrganizationId ?? undefined} onValueChange={onChangeTarget}>
        {children.map(child => (
          <label
            key={child.id}
            htmlFor={`add-people-target-${child.id}`}
            className="hover:bg-surface-hover flex items-center gap-3 rounded-md border px-3 py-2"
          >
            <RadioGroupItem value={child.id} id={`add-people-target-${child.id}`} />
            <span className="text-sm">{child.name}</span>
          </label>
        ))}
        {children.length === 0 && (
          <p className="text-muted-foreground text-sm">No sub-organizations available.</p>
        )}
      </RadioGroup>
      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext} disabled={!targetOrganizationId}>
          Next
        </Button>
      </div>
    </>
  );
}

function PreviewStep({
  selectedPeople,
  targetOrganizationId,
  role,
  onChangeRole,
  onBack,
  onConfirm,
}: {
  selectedPeople: Person[];
  targetOrganizationId: string;
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
  const eligibleCount = selectedPeople.filter(
    person => computeAddEligibility(person, targetOrganizationId).eligible
  ).length;

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
          You don't have permission to invite members into this sub-organization.
        </p>
      )}

      <ul className="divide-border max-h-80 divide-y overflow-y-auto rounded-md border">
        {selectedPeople.map(person => {
          const disabledLabel = addEligibilityLabel(person, targetOrganizationId);
          return (
            <li
              key={person.identityKey}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{person.name}</p>
                <p className="text-muted-foreground truncate text-xs">{person.email}</p>
              </div>
              {disabledLabel && (
                <span className="text-muted-foreground text-xs whitespace-nowrap">
                  {disabledLabel}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex justify-between gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onConfirm} disabled={!canInvite || eligibleCount === 0}>
          Invite {eligibleCount} {eligibleCount === 1 ? 'person' : 'people'}
        </Button>
      </div>
    </>
  );
}

function AddResultsStep({
  parentOrganizationId,
  selectedPeople,
  targetOrganizationId,
  role,
  onClose,
}: {
  parentOrganizationId: string;
  selectedPeople: Person[];
  targetOrganizationId: string;
  role: OrganizationRole;
  onClose: () => void;
}) {
  const posthog = usePostHog();
  const inviteMutation = useInviteMember();

  const skip = useCallback(
    (person: Person) => addEligibilityLabel(person, targetOrganizationId),
    [targetOrganizationId]
  );

  const execute = useCallback(
    async (person: Person) => {
      await inviteMutation.mutateAsync({
        organizationId: targetOrganizationId,
        email: person.email,
        role,
      });
    },
    [inviteMutation, targetOrganizationId, role]
  );

  const { outcomes, isRunning, progress, start, retryFailed } = useRowExecutor(
    selectedPeople,
    skip,
    execute
  );

  // This step only mounts when the wizard transitions into the results
  // step, so the mount/completion telemetry lifecycle below also kicks off
  // the batch (via `start`) at the right (and only) time.
  useWizardRunTelemetry({
    posthog,
    parentOrganizationId,
    wizardType: 'add',
    targetOrganizationId,
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
