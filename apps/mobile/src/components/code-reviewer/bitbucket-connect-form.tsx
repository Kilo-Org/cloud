import { useRef, useState } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useConnectBitbucket } from '@/lib/hooks/use-code-reviewer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export function BitbucketConnectForm({ scope }: Readonly<{ scope: string }>) {
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
          toast.success('Bitbucket connected');
        },
      }
    );
  };

  return (
    <View className="gap-3 rounded-lg bg-secondary p-6">
      <Text className="text-center text-sm font-medium">Connect Bitbucket</Text>
      <Text className="text-center text-xs text-muted-foreground">
        Create a Workspace Access Token with the required scopes and paste it below.
      </Text>
      <Text className="text-center text-xs text-muted-foreground">
        Account: read · Repositories: read/write · Pull requests: read · Webhooks: read/write
      </Text>
      <TextInput
        className="h-12 rounded-md border border-input bg-background px-3 text-sm leading-5 text-foreground"
        placeholder="Workspace access token"
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
        <Text>Connect</Text>
      </Button>
    </View>
  );
}
