import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { FilterChip } from '@/components/ui/filter-chip';
import { Text } from '@/components/ui/text';
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
          onPress={() => {
            onSelectHistory(false);
          }}
        >
          <Text>{t('agentBriefing.available')}</Text>
        </FilterChip>
        <FilterChip
          {...tabEntryA11y({ selected: history })}
          selected={history}
          onPress={() => {
            onSelectHistory(true);
          }}
        >
          <Text>{t('agentBriefing.history')}</Text>
        </FilterChip>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2"
      >
        <FilterChip
          selected={organizationId === undefined}
          accessibilityState={{ selected: organizationId === undefined }}
          onPress={() => {
            onSelectOrganization(undefined);
          }}
        >
          <Text>{t('common.all')}</Text>
        </FilterChip>
        <FilterChip
          selected={organizationId === null}
          accessibilityState={{ selected: organizationId === null }}
          onPress={() => {
            onSelectOrganization(null);
          }}
        >
          <Text>{t('common.personal')}</Text>
        </FilterChip>
        {organizations.map(organization => (
          <FilterChip
            key={organization.organizationId}
            selected={organizationId === organization.organizationId}
            accessibilityState={{ selected: organizationId === organization.organizationId }}
            onPress={() => {
              onSelectOrganization(organization.organizationId);
            }}
          >
            <Text>{organization.organizationName}</Text>
          </FilterChip>
        ))}
      </ScrollView>
    </>
  );
}
