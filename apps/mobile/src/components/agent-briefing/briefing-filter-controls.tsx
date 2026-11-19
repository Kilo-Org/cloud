import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

import { FilterChip } from '@/components/ui/filter-chip';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { tabEntryA11y } from '@/lib/a11y/tab-entry';

type BriefingOrganizationFilter = {
  organizationId: string;
  organizationName: string;
};

type BriefingFilterControlsProps = {
  /** True while the history list replaces the available reports. */
  history: boolean;
  onSelectHistory: (history: boolean) => void;
  /**
   * `undefined` reads every context, `null` personal only, and an organization
   * id narrows the list to that membership.
   */
  organizationId: string | null | undefined;
  organizations: readonly BriefingOrganizationFilter[];
  onSelectOrganization: (organizationId: string | null | undefined) => void;
};

const VIEW_OPTIONS = [
  { value: 'available' as const, labelKey: 'agentBriefing.available' },
  { value: 'history' as const, labelKey: 'agentBriefing.history' },
];

/**
 * The available/History switch and the context filter chips above the briefing
 * list. The switch is a `SegmentedControl`, the control every other view switch
 * in the app uses; chips stay for the filters, so the two rows keep their
 * hierarchy. Both rows pick one option at a time, so every option carries
 * `accessibilityState.selected` for the active one; the chips row announces as
 * a tablist, and each row carries the name that says what its options narrow.
 */
export function BriefingFilterControls({
  history,
  onSelectHistory,
  organizationId,
  organizations,
  onSelectOrganization,
}: Readonly<BriefingFilterControlsProps>) {
  const { t } = useTranslation();
  return (
    <>
      <SegmentedControl
        options={VIEW_OPTIONS.map(option => ({
          value: option.value,
          label: t(option.labelKey),
        }))}
        value={history ? 'history' : 'available'}
        onChange={value => {
          onSelectHistory(value === 'history');
        }}
        // The switch has no visible group name of its own; the screen title
        // names it without adding copy.
        accessibilityLabel={t('agentBriefing.title')}
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2"
        accessibilityRole="tablist"
        accessibilityLabel={t('agentBriefing.filterByContext')}
      >
        <FilterChip
          {...tabEntryA11y({ selected: organizationId === undefined })}
          selected={organizationId === undefined}
          label={t('agentBriefing.contextAll')}
          onPress={() => {
            onSelectOrganization(undefined);
          }}
        />
        <FilterChip
          {...tabEntryA11y({ selected: organizationId === null })}
          selected={organizationId === null}
          label={t('common.personal')}
          onPress={() => {
            onSelectOrganization(null);
          }}
        />
        {organizations.map(organization => (
          <FilterChip
            key={organization.organizationId}
            {...tabEntryA11y({ selected: organizationId === organization.organizationId })}
            selected={organizationId === organization.organizationId}
            label={organization.organizationName}
            onPress={() => {
              onSelectOrganization(organization.organizationId);
            }}
          />
        ))}
      </ScrollView>
    </>
  );
}
