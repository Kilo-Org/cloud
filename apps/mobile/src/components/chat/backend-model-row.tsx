import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';

import { type BackendModelFields } from './backend-form-state';

export function BackendModelRow({
  model,
  onChange,
  onRemove,
  onCheck,
  busy,
}: Readonly<{
  model: BackendModelFields;
  onChange: (patch: Partial<BackendModelFields>) => void;
  onRemove: () => void;
  onCheck: () => void;
  busy: boolean;
}>) {
  const { t } = useTranslation();
  const [tools, setTools] = useState(model.tools);
  const [images, setImages] = useState(model.images);
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <FormField
        label={t('modelChat.backends.modelId')}
        defaultValue={model.id}
        autoCapitalize="none"
        autoCorrect={false}
        disabled={busy}
        onChangeText={id => {
          onChange({ id });
        }}
      />
      <FormField
        label={t('modelChat.backends.modelName')}
        defaultValue={model.name}
        disabled={busy}
        onChangeText={name => {
          onChange({ name });
        }}
      />
      <FormField
        label={t('modelChat.backends.contextWindow')}
        defaultValue={model.contextWindow}
        keyboardType="number-pad"
        disabled={busy}
        onChangeText={contextWindow => {
          onChange({ contextWindow });
        }}
      />
      <FormField
        label={t('modelChat.backends.maxOutputTokens')}
        defaultValue={model.maxOutputTokens}
        keyboardType="number-pad"
        disabled={busy}
        onChangeText={maxOutputTokens => {
          onChange({ maxOutputTokens });
        }}
      />
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1">{t('modelChat.backends.modelTools')}</Text>
        <Switch
          accessibilityLabel={t('modelChat.backends.modelTools')}
          value={tools}
          disabled={busy}
          onValueChange={value => {
            setTools(value);
            onChange({ tools: value });
          }}
        />
      </View>
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1">{t('modelChat.backends.modelImages')}</Text>
        <Switch
          accessibilityLabel={t('modelChat.backends.modelImages')}
          value={images}
          disabled={busy}
          onValueChange={value => {
            setImages(value);
            onChange({ images: value });
          }}
        />
      </View>
      <Button variant="outline" disabled={busy} onPress={onCheck}>
        <Text>{t('modelChat.backends.checkConnection')}</Text>
      </Button>
      <Button variant="ghost" disabled={busy} onPress={onRemove}>
        <Text>{t('modelChat.backends.removeModel')}</Text>
      </Button>
    </View>
  );
}
