import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

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
          `accessibilityRole`, so the tabs pass `role` to replace it. */}
      <View accessibilityRole="tablist" className="flex-row flex-wrap gap-2">
        <Button
          role="tab"
          variant={history ? 'ghost' : 'secondary'}
          size="sm"
          accessibilityState={{ selected: !history }}
          onPress={() => {
            onSelectHistory(false);
          }}
        >
          <Text>{t('agentBriefing.available')}</Text>
        </Button>
        <Button
          role="tab"
          variant={history ? 'secondary' : 'ghost'}
          size="sm"
          accessibilityState={{ selected: history }}
          onPress={() => {
            onSelectHistory(true);
          }}
        >
          <Text>{t('agentBriefing.history')}</Text>
        </Button>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2"
      >
        <Button
          variant={organizationId === undefined ? 'secondary' : 'ghost'}
          size="sm"
          accessibilityState={{ selected: organizationId === undefined }}
          onPress={() => {
            onSelectOrganization(undefined);
          }}
        >
          <Text>{t('common.all')}</Text>
        </Button>
        <Button
          variant={organizationId === null ? 'secondary' : 'ghost'}
          size="sm"
          accessibilityState={{ selected: organizationId === null }}
          onPress={() => {
            onSelectOrganization(null);
          }}
        >
          <Text>{t('common.personal')}</Text>
        </Button>
        {organizations.map(organization => (
          <Button
            key={organization.organizationId}
            variant={organizationId === organization.organizationId ? 'secondary' : 'ghost'}
            size="sm"
            accessibilityState={{ selected: organizationId === organization.organizationId }}
            onPress={() => {
              onSelectOrganization(organization.organizationId);
            }}
          >
            <Text>{organization.organizationName}</Text>
          </Button>
        ))}
      </ScrollView>
    </>
  );
}
