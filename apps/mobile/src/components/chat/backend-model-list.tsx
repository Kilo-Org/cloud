import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

import { BackendModelRow } from './backend-model-row';
import { type BackendModelFields } from './backend-form-state';

/**
 * The model rows of the backend form: each row's fields, the checks, and the
 * control that adds a blank one. The parent owns the row list because it also
 * serializes it for the save.
 */
export function BackendModelList({
  models,
  busy,
  onChange,
  onRemove,
  onCheck,
  onAdd,
}: Readonly<{
  models: readonly BackendModelFields[];
  busy: boolean;
  onChange: (key: string, patch: Partial<BackendModelFields>) => void;
  onRemove: (key: string) => void;
  onCheck: (key: string) => void;
  onAdd: () => void;
}>) {
  const { t } = useTranslation();
  return (
    <View className="gap-4">
      <Text>{t('modelChat.backends.models')}</Text>
      <Text className="text-sm text-muted-foreground">{t('modelChat.backends.checkHelp')}</Text>
      {models.map(model => (
        <BackendModelRow
          key={model.key}
          model={model}
          busy={busy}
          onChange={patch => {
            onChange(model.key, patch);
          }}
          onRemove={() => {
            onRemove(model.key);
          }}
          onCheck={() => {
            onCheck(model.key);
          }}
        />
      ))}
      <Button
        variant="outline"
        disabled={busy}
        onPress={() => {
          onAdd();
        }}
      >
        <Text>{t('modelChat.backends.addModel')}</Text>
      </Button>
    </View>
  );
}
