import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { FormField } from '@/components/ui/form-field';
import { Eye, EyeOff } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function BackendHeadersField({
  defaultValue,
  busy,
  onChangeText,
}: Readonly<{ defaultValue: string; busy: boolean; onChangeText: (headers: string) => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [revealed, setRevealed] = useState(false);
  const value = useRef(defaultValue);

  return (
    <>
      {revealed ? (
        <FormField
          label={t('profiles.mcp.headers')}
          defaultValue={value.current}
          multiline
          className="min-h-28 leading-5"
          autoCapitalize="none"
          autoCorrect={false}
          disabled={busy}
          onChangeText={headers => {
            value.current = headers;
            onChangeText(headers);
          }}
        />
      ) : (
        <View className="gap-1.5">
          <Text className="text-sm font-medium text-foreground">{t('profiles.mcp.headers')}</Text>
          <Text
            className="rounded-md border border-input bg-background p-3 text-muted-foreground"
            accessibilityLabel={t('profiles.secrets.masked')}
          >
            ••••••••
          </Text>
        </View>
      )}
      <Pressable
        className="min-h-11 flex-row items-center gap-2 self-start px-1 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('profiles.secrets.reveal')}
        accessibilityState={{ selected: revealed, disabled: busy }}
        disabled={busy}
        onPress={() => {
          setRevealed(current => !current);
        }}
      >
        {revealed ? (
          <EyeOff size={18} color={colors.mutedForeground} />
        ) : (
          <Eye size={18} color={colors.mutedForeground} />
        )}
        <Text className="text-sm text-muted-foreground">{t('profiles.secrets.reveal')}</Text>
      </Pressable>
    </>
  );
}
