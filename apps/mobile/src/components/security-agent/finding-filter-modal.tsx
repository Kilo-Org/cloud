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
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';

const STATUS_OPTIONS = [
  { value: 'open', labelKey: 'securityAgent.filter.statusOpen' },
  { value: 'fixed', labelKey: 'securityAgent.filter.fixed' },
  { value: 'ignored', labelKey: 'securityAgent.filter.statusIgnored' },
  { value: 'closed', labelKey: 'securityAgent.filter.statusClosed' },
  { value: 'all', labelKey: 'securityAgent.filter.all' },
] as const satisfies readonly { value: SecurityFindingStatusFilter; labelKey: string }[];

const SEVERITY_OPTIONS = [
  { value: 'all', labelKey: 'securityAgent.filter.all' },
  { value: 'critical', labelKey: 'securityAgent.filter.severityCritical' },
  { value: 'high', labelKey: 'securityAgent.filter.severityHigh' },
  { value: 'medium', labelKey: 'securityAgent.filter.severityMedium' },
  { value: 'low', labelKey: 'securityAgent.filter.severityLow' },
] as const satisfies readonly { value: SecuritySeverityFilter; labelKey: string }[];

const OUTCOME_OPTIONS = [
  { value: 'all', labelKey: 'securityAgent.filter.all' },
  { value: 'not_analyzed', labelKey: 'securityAgent.filter.outcomeNotAnalyzed' },
  { value: 'analyzing', labelKey: 'securityAgent.filter.outcomeAnalyzing' },
  { value: 'failed', labelKey: 'securityAgent.filter.outcomeFailed' },
  { value: 'exploitable', labelKey: 'securityAgent.filter.outcomeExploitable' },
  { value: 'not_exploitable', labelKey: 'securityAgent.filter.outcomeNotExploitable' },
  { value: 'safe_to_dismiss', labelKey: 'securityAgent.filter.outcomeSafeToDismiss' },
  { value: 'needs_review', labelKey: 'securityAgent.filter.outcomeNeedsReview' },
  { value: 'triage_complete', labelKey: 'securityAgent.filter.outcomeTriageComplete' },
  { value: 'fixed', labelKey: 'securityAgent.filter.fixed' },
  { value: 'dismissed', labelKey: 'securityAgent.filter.outcomeDismissed' },
] as const satisfies readonly { value: SecurityOutcomeFilter; labelKey: string }[];

const SORT_OPTIONS = [
  { value: 'severity_desc', labelKey: 'securityAgent.filter.sortSeverityDesc' },
  { value: 'severity_asc', labelKey: 'securityAgent.filter.sortSeverityAsc' },
  { value: 'sla_due_at_asc', labelKey: 'securityAgent.filter.sortSlaDue' },
] as const satisfies readonly { value: SecurityFindingSortBy; labelKey: string }[];

const SLA_STATUS_OPTIONS = [
  { value: false, labelKey: 'securityAgent.filter.all' },
  { value: true, labelKey: 'securityAgent.filter.overdueOnly' },
] as const satisfies readonly { value: boolean; labelKey: string }[];

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
      <RadioGroup label={title}>
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
      </RadioGroup>
    </View>
  );
}

export function FindingFilterModal({
  filters,
  repositories,
  onChange,
}: Readonly<FindingFilterModalProps>) {
  const { t } = useTranslation();
  const statusOptions = STATUS_OPTIONS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  }));
  const severityOptions = SEVERITY_OPTIONS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  }));
  const outcomeOptions = OUTCOME_OPTIONS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  }));
  const sortOptions = SORT_OPTIONS.map(({ value, labelKey }) => ({ value, label: t(labelKey) }));
  const slaStatusOptions = SLA_STATUS_OPTIONS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  }));
  const repoOptions: { value: string | null; label: string }[] = [
    { value: null, label: t('securityAgent.filter.allRepositories') },
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
        <Text>{t('securityAgent.filter.reset')}</Text>
      </Button>
      <View className="gap-4">
        <FilterSection
          title={t('securityAgent.filter.repository')}
          options={repoOptions}
          selected={filters.repoFullName}
          onSelect={repoFullName => {
            onChange({ ...filters, repoFullName });
          }}
        />
        <FilterSection
          title={t('securityAgent.filter.status')}
          options={statusOptions}
          selected={filters.status}
          onSelect={status => {
            onChange(selectSecurityFindingStatus(filters, status));
          }}
        />
        <FilterSection
          title={t('securityAgent.filter.severity')}
          options={severityOptions}
          selected={filters.severity}
          onSelect={severity => {
            onChange({ ...filters, severity });
          }}
        />
        <FilterSection
          title={t('securityAgent.filter.outcome')}
          options={outcomeOptions}
          selected={filters.outcome}
          onSelect={outcome => {
            onChange(selectSecurityFindingOutcome(filters, outcome));
          }}
        />
        <FilterSection
          title={t('securityAgent.filter.slaStatus')}
          options={slaStatusOptions}
          selected={Boolean(filters.overdue)}
          onSelect={overdue => {
            onChange({ ...filters, overdue: overdue ? true : undefined });
          }}
        />
        <FilterSection
          title={t('securityAgent.filter.sortBy')}
          options={sortOptions}
          selected={filters.sortBy}
          onSelect={sortBy => {
            onChange({ ...filters, sortBy });
          }}
        />
      </View>
    </View>
  );
}
