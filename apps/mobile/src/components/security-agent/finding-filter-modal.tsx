import {
  DEFAULT_SECURITY_FINDING_FILTERS,
  type SecurityFindingFilters,
  type SecurityFindingSortBy,
  type SecurityFindingStatusFilter,
  type SecurityOutcomeFilter,
  type SecuritySeverityFilter,
  selectSecurityFindingOutcome,
  selectSecurityFindingStatus,
} from '@kilocode/app-shared/security-agent';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Text } from '@/components/ui/text';

const STATUS_OPTIONS: { value: SecurityFindingStatusFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'ignored', label: 'Ignored' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

const SEVERITY_OPTIONS: { value: SecuritySeverityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const OUTCOME_OPTIONS: { value: SecurityOutcomeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'not_analyzed', label: 'Not analyzed' },
  { value: 'analyzing', label: 'Analyzing' },
  { value: 'failed', label: 'Analysis failed' },
  { value: 'exploitable', label: 'Exploitable' },
  { value: 'not_exploitable', label: 'Not exploitable' },
  { value: 'safe_to_dismiss', label: 'Safe to dismiss' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'triage_complete', label: 'Triage complete' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'dismissed', label: 'Dismissed' },
];

const SORT_OPTIONS: { value: SecurityFindingSortBy; label: string }[] = [
  { value: 'severity_desc', label: 'Severity: high to low' },
  { value: 'severity_asc', label: 'Severity: low to high' },
  { value: 'sla_due_at_asc', label: 'SLA due date' },
];

const SLA_STATUS_OPTIONS: { value: boolean; label: string }[] = [
  { value: false, label: 'All' },
  { value: true, label: 'Overdue only' },
];

type FindingRepositoryOption = {
  fullName: string;
};

type FindingFilterModalProps = {
  filters: SecurityFindingFilters;
  repositories: FindingRepositoryOption[];
  onChange: (filters: SecurityFindingFilters) => void;
};

type FilterOptionRowProps = {
  label: string;
  isSelected: boolean;
  onPress: () => void;
};

function FilterOptionRow({ label, isSelected, onPress }: Readonly<FilterOptionRowProps>) {
  return (
    <ChoiceRow selected={isSelected} onPress={onPress} className="rounded-lg px-3 py-2.5">
      <Text className="flex-1 text-sm" numberOfLines={1}>
        {label}
      </Text>
    </ChoiceRow>
  );
}

function FilterSection<T>({
  title,
  options,
  selected,
  onSelect,
}: Readonly<{
  title: string;
  options: { value: T; label: string }[];
  selected: T;
  onSelect: (value: T) => void;
}>) {
  return (
    <View className="gap-1">
      <Text variant="eyebrow" className="px-3">
        {title}
      </Text>
      {options.map(option => (
        <FilterOptionRow
          key={String(option.value)}
          label={option.label}
          isSelected={option.value === selected}
          onPress={() => {
            onSelect(option.value);
          }}
        />
      ))}
    </View>
  );
}

export function FindingFilterModal({
  filters,
  repositories,
  onChange,
}: Readonly<FindingFilterModalProps>) {
  const repoOptions: { value: string | null; label: string }[] = [
    { value: null, label: 'All repositories' },
    ...repositories.map(repo => ({ value: repo.fullName, label: repo.fullName })),
  ];

  return (
    <View className="gap-6 bg-background px-6 pb-8 pt-4">
      <Button
        variant="ghost"
        className="self-start"
        onPress={() => {
          onChange(DEFAULT_SECURITY_FINDING_FILTERS);
        }}
      >
        <Text>Reset</Text>
      </Button>
      <View className="gap-4">
        <FilterSection
          title="Repository"
          options={repoOptions}
          selected={filters.repoFullName}
          onSelect={repoFullName => {
            onChange({ ...filters, repoFullName });
          }}
        />
        <FilterSection
          title="Status"
          options={STATUS_OPTIONS}
          selected={filters.status}
          onSelect={status => {
            onChange(selectSecurityFindingStatus(filters, status));
          }}
        />
        <FilterSection
          title="Severity"
          options={SEVERITY_OPTIONS}
          selected={filters.severity}
          onSelect={severity => {
            onChange({ ...filters, severity });
          }}
        />
        <FilterSection
          title="Outcome"
          options={OUTCOME_OPTIONS}
          selected={filters.outcome}
          onSelect={outcome => {
            onChange(selectSecurityFindingOutcome(filters, outcome));
          }}
        />
        <FilterSection
          title="SLA status"
          options={SLA_STATUS_OPTIONS}
          selected={Boolean(filters.overdue)}
          onSelect={overdue => {
            onChange({ ...filters, overdue: overdue ? true : undefined });
          }}
        />
        <FilterSection
          title="Sort by"
          options={SORT_OPTIONS}
          selected={filters.sortBy}
          onSelect={sortBy => {
            onChange({ ...filters, sortBy });
          }}
        />
      </View>
    </View>
  );
}
