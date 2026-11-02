import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { FilterChip } from '@/components/ui/filter-chip';
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

/**
 * Available/History tabs and the context filter chips above the briefing list.
 * Both rows pick one option at a time, so every option carries
 * `accessibilityState.selected` for the active one; the tabs also announce as a
 * tablist instead of a loose pair of buttons.
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
      {/* `Button` pins role="button" and `role` takes precedence over
          `accessibilityRole`, so the tabs pass the entry's own role. */}
      <View accessibilityRole="tablist" className="flex-row flex-wrap gap-2">
        <FilterChip
          {...tabEntryA11y({ selected: !history })}
          selected={!history}
          label={t('agentBriefing.available')}
          onPress={() => {
            onSelectHistory(false);
          }}
        />
        <FilterChip
          {...tabEntryA11y({ selected: history })}
          selected={history}
          label={t('agentBriefing.history')}
          onPress={() => {
            onSelectHistory(true);
          }}
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2"
      >
        <FilterChip
          selected={organizationId === undefined}
          label={t('common.all')}
          onPress={() => {
            onSelectOrganization(undefined);
          }}
        />
        <FilterChip
          selected={organizationId === null}
          label={t('common.personal')}
          onPress={() => {
            onSelectOrganization(null);
          }}
        />
        {organizations.map(organization => (
          <FilterChip
            key={organization.organizationId}
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
