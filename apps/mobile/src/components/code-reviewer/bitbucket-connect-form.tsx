import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
          toast.success(t('common.bitbucketConnected'));
        },
      }
    );
  };

  return (
    <View className="gap-3 rounded-lg bg-secondary p-6">
      <Text className="text-center text-sm font-medium">{t('common.connectBitbucket')}</Text>
      <Text className="text-center text-xs text-muted-foreground">
        {t('codeReviewer.bitbucketConnect.description')}
      </Text>
      <Text className="text-center text-xs text-muted-foreground">
        {t('codeReviewer.bitbucketConnect.scopes')}
      </Text>
      <Input
        // The shared single-line box supplies the touch floor
        // (`min-h-[44px]`, never a fixed height or `py-*`); the field keeps
        // its own chrome, horizontal inset and line box.
        className="rounded-md border border-input bg-background px-3 text-sm leading-[normal] text-foreground"
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
        <Text>{t('common.connect')}</Text>
      </Button>
    </View>
  );
}
