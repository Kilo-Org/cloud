import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';

export type ProviderKey = inferRouterOutputs<MobileRouter>['byok']['list'][number];

export function ProviderKeyRow({
  providerKey,
  testing,
  toggling,
  deleting,
  canEdit,
  onTest,
  onToggle,
  onEdit,
  onDelete,
}: Readonly<{
  providerKey: ProviderKey;
  testing: boolean;
  toggling: boolean;
  deleting: boolean;
  canEdit: boolean;
  onTest: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  const { t } = useTranslation();
  // A key the coding plan manages cannot be changed here: the plan created it and
  // only ending the plan removes it, so every control is closed and the row says
  // why instead of failing a server call the reader could not predict.
  const managed = providerKey.management_source === 'coding_plan';
  const editable = canEdit && !managed;
  const busy = testing || toggling || deleting;

  return (
    <Card>
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text variant="small" numberOfLines={1}>
            {providerKey.provider_name}
          </Text>
          {/*
            Only a managed row keeps a line: its switch is disabled, so it cannot
            carry the state and the row has to name the plan instead.
          */}
          {managed ? (
            <Text variant="caption" numberOfLines={1}>
              {t('profile.providerKeys.managedByPlan')}
            </Text>
          ) : null}
        </View>
        <Switch
          value={providerKey.is_enabled}
          disabled={!editable || busy}
          onValueChange={onToggle}
          accessibilityLabel={t('profile.providerKeys.enableKey', {
            provider: providerKey.provider_name,
          })}
        />
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className={STATE_ACTION_CLASS}
          disabled={!editable || busy}
          loading={testing}
          onPress={onTest}
        >
          <Text>{t('profile.providerKeys.test')}</Text>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={STATE_ACTION_CLASS}
          disabled={!editable || busy}
          onPress={onEdit}
        >
          <Text>{t('profile.providerKeys.edit')}</Text>
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={STATE_ACTION_CLASS}
          disabled={!editable || busy}
          loading={deleting}
          onPress={onDelete}
        >
          <Text>{t('common.remove')}</Text>
        </Button>
      </View>
    </Card>
  );
}
