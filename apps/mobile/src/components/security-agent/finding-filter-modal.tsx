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
import { Check } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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

type FindingRepositoryOption = {
  fullName: string;
};

type FindingFilterModalProps = {
  filters: SecurityFindingFilters;
  repositories: FindingRepositoryOption[];
  onClose: () => void;
  onApply: (filters: SecurityFindingFilters) => void;
};

type FilterOptionRowProps = {
  label: string;
  isSelected: boolean;
  onPress: () => void;
};

function FilterOptionRow({ label, isSelected, onPress }: Readonly<FilterOptionRowProps>) {
  const colors = useThemeColors();

  return (
    <Pressable
      className="min-h-11 flex-row items-center justify-between rounded-lg px-3 py-2.5 active:bg-secondary"
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: isSelected }}
    >
      <Text className="flex-1 text-sm" numberOfLines={1}>
        {label}
      </Text>
      {isSelected && <Check size={16} color={colors.primary} />}
    </Pressable>
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
  onClose,
  onApply,
}: Readonly<FindingFilterModalProps>) {
  const [draft, setDraft] = useState<SecurityFindingFilters>(filters);

  const repoOptions: { value: string | null; label: string }[] = [
    { value: null, label: 'All repositories' },
    ...repositories.map(repo => ({ value: repo.fullName, label: repo.fullName })),
  ];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-start px-6 pt-[15%]">
        <Pressable className="absolute inset-0" onPress={onClose} accessible={false}>
          <View className="absolute inset-0 bg-black opacity-50" />
        </Pressable>
        <View className="max-h-[75%] gap-4 rounded-2xl bg-popover p-5" accessibilityViewIsModal>
          <Text className="text-base font-semibold">Filter Findings</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View className="gap-4">
              <FilterSection
                title="Repository"
                options={repoOptions}
                selected={draft.repoFullName}
                onSelect={repoFullName => {
                  setDraft(prev => ({ ...prev, repoFullName }));
                }}
              />
              <FilterSection
                title="Status"
                options={STATUS_OPTIONS}
                selected={draft.status}
                onSelect={status => {
                  setDraft(prev => selectSecurityFindingStatus(prev, status));
                }}
              />
              <FilterSection
                title="Severity"
                options={SEVERITY_OPTIONS}
                selected={draft.severity}
                onSelect={severity => {
                  setDraft(prev => ({ ...prev, severity }));
                }}
              />
              <FilterSection
                title="Outcome"
                options={OUTCOME_OPTIONS}
                selected={draft.outcome}
                onSelect={outcome => {
                  setDraft(prev => selectSecurityFindingOutcome(prev, outcome));
                }}
              />
              <FilterSection
                title="Sort by"
                options={SORT_OPTIONS}
                selected={draft.sortBy}
                onSelect={sortBy => {
                  setDraft(prev => ({ ...prev, sortBy }));
                }}
              />
            </View>
          </ScrollView>
          <View className="flex-row items-center justify-between gap-3">
            <Button
              variant="ghost"
              onPress={() => {
                onApply(DEFAULT_SECURITY_FINDING_FILTERS);
                onClose();
              }}
            >
              <Text>Reset</Text>
            </Button>
            <View className="flex-row gap-3">
              <Button variant="outline" onPress={onClose}>
                <Text>Cancel</Text>
              </Button>
              <Button
                onPress={() => {
                  onApply(draft);
                  onClose();
                }}
              >
                <Text className="text-primary-foreground">Apply</Text>
              </Button>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}
