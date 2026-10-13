import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Wrench } from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { Text } from '@/components/ui/text';

import { kiloServerRow, type McpSettingsView } from './mcp-settings-state';

type KiloMcpSectionProps = {
  view: McpSettingsView;
  retrying: boolean;
  onToggle: (next: boolean) => void;
  onRetry: () => void;
};

export function KiloMcpSection({
  view,
  retrying,
  onToggle,
  onRetry,
}: Readonly<KiloMcpSectionProps>) {
  const { t } = useTranslation();
  const kilo = kiloServerRow(view);

  return (
    <View className="gap-2">
      <PreferenceRow
        icon={Wrench}
        title={t('modelChat.mcp.use')}
        subtitle={t('modelChat.mcp.useDescription')}
        value={kilo.enabled}
        disabled={!kilo.toggleable}
        busy={kilo.busy}
        onValueChange={onToggle}
      />
      <View className="min-h-6 justify-center px-1">
        <Text className="text-sm font-medium text-foreground">
          {t(kilo.statusKey, { count: kilo.toolCount })}
        </Text>
      </View>
      {kilo.descriptionKey === null ? null : (
        <Text variant="muted" className="px-1 text-xs">
          {t(kilo.descriptionKey)}
        </Text>
      )}
      <Text variant="muted" className="px-1 text-xs">
        {t('modelChat.mcp.kiloBuiltIn')}
      </Text>
      {kilo.retry ? (
        <Button
          // React Native on Android does not restore the label after busy clears on the same view.
          key={retrying ? 'retrying' : 'idle'}
          variant="secondary"
          onPress={onRetry}
          loading={retrying}
          accessibilityLabel={t('common.retry')}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
    </View>
  );
}
