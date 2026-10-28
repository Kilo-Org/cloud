import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Text } from '@/components/ui/text';
import { chatTargetKind } from '@/lib/chat/backend-target';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useOrganization } from '@/lib/organization-context';

/** The chat's own model disclosure decides which model the next message goes to. */
export type ProviderSelection = {
  readonly selectedModel?: string;
  readonly onSelectModel?: (modelId: string) => void;
};

/**
 * One provider choice. Without a model id, or without the chat's disclosure, the
 * row only states what the provider offers: the history screen has no model picker.
 */
export function BackendProviderChoice({
  name,
  description,
  modelId,
  selectedModel,
  onSelectModel,
}: ProviderSelection & Readonly<{ name: string; description: string; modelId?: string }>) {
  const content = (
    <View className="min-w-0 flex-1 gap-0.5 pr-3">
      <Text className="text-sm font-medium">{name}</Text>
      <Text variant="muted" className="text-xs">
        {description}
      </Text>
    </View>
  );
  if (modelId === undefined || onSelectModel === undefined) {
    return <View className="min-h-11 flex-row items-center py-2">{content}</View>;
  }
  return (
    <ChoiceRow
      selected={selectedModel === modelId}
      onPress={() => {
        onSelectModel(modelId);
      }}
    >
      {content}
    </ChoiceRow>
  );
}

export function CloudProviderChoice(selection: ProviderSelection) {
  const { t } = useTranslation();
  const { organizationId } = useOrganization();
  const catalog = useAvailableModels(organizationId ?? undefined);
  const preferred = catalog.models.find(model => model.isPreferred) ?? catalog.models[0];
  const selected =
    selection.selectedModel !== undefined && chatTargetKind(selection.selectedModel) === 'kilo'
      ? selection.selectedModel
      : undefined;
  const target = selected ?? preferred?.id;
  return (
    <View className="gap-2 rounded-xl border border-border p-4">
      <BackendProviderChoice
        {...selection}
        name={t('modelChat.backends.defaultKilo')}
        description={t('modelChat.backends.kiloHelp')}
        modelId={target}
      />
      {catalog.isLoading && (
        <Text variant="muted" className="text-xs">
          {t('common.loading')}
        </Text>
      )}
      {!catalog.isLoading && target === undefined && (
        <Text variant="muted" className="text-xs">
          {t('modelChat.backends.cloudUnavailable')}
        </Text>
      )}
      {target !== undefined && (
        <Text variant="muted" className="text-xs">
          {t('modelChat.backends.cloudModel', {
            model: catalog.models.find(model => model.id === target)?.name ?? target,
          })}
        </Text>
      )}
      {catalog.isError && (
        <View className="gap-2">
          <Text accessibilityRole="alert" className="text-xs text-destructive">
            {t('common.couldNotLoadModels')}
          </Text>
          <Button
            size="sm"
            variant="outline"
            disabled={catalog.isFetching}
            onPress={() => void catalog.refetch()}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      )}
    </View>
  );
}
