import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, TextInput, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useConnectBitbucket } from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function BitbucketConnectForm({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const tokenRef = useRef('');
  const [canConnect, setCanConnect] = useState(false);
  const connect = useConnectBitbucket(scope);

  const onConnect = () => {
    const token = tokenRef.current.trim();
    if (!token) {
      return;
    }
    connect.mutate(
      { accessToken: token },
      {
        onSuccess: () => {
          toast.success(t('codeReviewer.bitbucketConnect.connected'));
        },
      }
    );
  };

  return (
    <View className="gap-3 rounded-lg bg-secondary p-6">
      <Text className="text-center text-sm font-medium">
        {t('codeReviewer.bitbucketConnect.title')}
      </Text>
      <Text className="text-center text-xs text-muted-foreground">
        {t('codeReviewer.bitbucketConnect.description')}
      </Text>
      <Text className="text-center text-xs text-muted-foreground">
        {t('codeReviewer.bitbucketConnect.scopes')}
      </Text>
      <TextInput
        className="h-12 rounded-md border border-input bg-background px-3 text-sm leading-[normal] text-foreground"
        placeholder={t('codeReviewer.bitbucketConnect.tokenPlaceholder')}
        placeholderTextColor={colors.mutedForeground}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        onChangeText={value => {
          tokenRef.current = value;
          setCanConnect(value.trim().length > 0);
        }}
      />
      <Button
        className="w-full flex-row gap-2"
        disabled={connect.isPending || !canConnect}
        onPress={onConnect}
      >
        {connect.isPending ? <ActivityIndicator size="small" /> : null}
        <Text>{t('codeReviewer.bitbucketConnect.connect')}</Text>
      </Button>
    </View>
  );
}
