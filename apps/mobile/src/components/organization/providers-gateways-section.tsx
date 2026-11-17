import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import {
  SettingsSection,
  SettingsSwitchRow,
  SettingsValueRow,
} from '@/components/organization/settings-form-sections';
import { QueryError } from '@/components/query-error';
import { Settings2 } from '@/components/ui/icons';
import { MenuSheet } from '@/components/ui/menu-sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';
import {
  type OrgGatewaySettings,
  useSaveOrgGatewaySettings,
} from '@/lib/hooks/use-org-settings-queries';

type Region = 'us' | 'eu' | 'au' | 'jp';
type RegionChoice = Region | 'global';

const REGION_KEYS = {
  global: 'organizationModelAccess.region.global',
  us: 'organizationModelAccess.region.us',
  eu: 'organizationModelAccess.region.eu',
  au: 'organizationModelAccess.region.au',
  jp: 'organizationModelAccess.region.jp',
} satisfies Record<RegionChoice, string>;

const REGION_CHOICES = [
  'global',
  'us',
  'eu',
  'au',
  'jp',
] as const satisfies readonly RegionChoice[];

/**
 * The gateway's own settings. Each control saves on its own, like the web tab:
 * there is no draft here, and every write answers with the new settings.
 */
export function GatewaySettingsSection({
  organizationId,
  settings,
  isError,
  isFetching,
  canEdit,
  onRetry,
}: Readonly<{
  organizationId: string;
  settings: OrgGatewaySettings | undefined;
  isError: boolean;
  isFetching: boolean;
  canEdit: boolean;
  onRetry: () => void;
}>) {
  const { t } = useTranslation();
  const save = useSaveOrgGatewaySettings(organizationId);
  const [regionPickerOpen, setRegionPickerOpen] = useState(false);
  const region: RegionChoice = settings?.data_region ?? 'global';

  if (isError && settings == null) {
    return (
      <QueryError
        className="bg-background"
        message={t('organizationModelAccess.loadError')}
        onRetry={onRetry}
        isRetrying={isFetching}
      />
    );
  }

  if (settings == null) {
    return (
      <View className="gap-3 px-4 pt-3">
        <Skeleton className="h-40 w-full rounded-lg bg-muted-soft" />
      </View>
    );
  }

  if (!settings.available) {
    return (
      <EmptyState
        placement="top"
        className="bg-background px-4 pt-4"
        icon={Settings2}
        title={t('organizationModelAccess.gatewaysUnavailable')}
      />
    );
  }

  const disabled = !canEdit || save.isPending;

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-10')}
      keyboardShouldPersistTaps="handled"
    >
      <SettingsSection
        title={t('organizationModelAccess.tabGateways')}
        description={t('organizationModelAccess.gatewaysDescription')}
      >
        <SettingsSwitchRow
          label={t('organizationModelAccess.openrouter')}
          description={t('organizationModelAccess.openrouterNote')}
          value={!settings.disable_openrouter}
          disabled={disabled}
          onValueChange={enabled => {
            save.mutate({ organizationId, disable_openrouter: !enabled });
          }}
        />
        <SettingsValueRow
          label={t('organizationModelAccess.inferenceRegion')}
          value={t(REGION_KEYS[region])}
          disabled={disabled}
          onPress={() => {
            setRegionPickerOpen(true);
          }}
        />
        <Text variant="caption">
          {t('organizationModelAccess.inferenceRegionDescription')}
        </Text>
        <Text variant="caption">
          {t('organizationModelAccess.disableOpenrouterNote')}
        </Text>
      </SettingsSection>
      <MenuSheet
        visible={regionPickerOpen}
        title={t('organizationModelAccess.inferenceRegion')}
        options={REGION_CHOICES.map(choice => ({
          label: t(REGION_KEYS[choice]),
          selected: region === choice,
        }))}
        cancelLabel={t('common.cancel')}
        onSelect={index => {
          const choice = REGION_CHOICES[index];
          setRegionPickerOpen(false);
          if (choice !== undefined) {
            save.mutate({
              organizationId,
              data_region: choice === 'global' ? null : choice,
            });
          }
        }}
        onClose={() => {
          setRegionPickerOpen(false);
        }}
      />
    </ScrollView>
  );
}
