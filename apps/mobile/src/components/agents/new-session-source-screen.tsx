import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { Cloud, Server } from 'lucide-react-native';
import { View } from 'react-native';

import { ConfigureRow } from '@/components/ui/configure-row';
import { Text } from '@/components/ui/text';
import { ScreenHeader } from '@/components/screen-header';

import { buildNewSessionSourcePaths } from './new-session-source-paths';

const CLOUD_TITLE = 'Cloud Agent';
const CLOUD_SUBTITLE = 'Start a cloud-hosted session in this account.';
const LOCAL_TITLE = 'Local runtime';
const LOCAL_SUBTITLE = 'Discover runtimes already running Kilo CLI on your machines.';

/**
 * Source chooser for the new-session flow. The user picks where the session
 * runs; each choice does a `router.replace` so the Back button skips the
 * chooser and lands on the previous screen.
 */
export function NewSessionSourceScreen() {
  const router = useRouter();
  const { organizationId } = useLocalSearchParams<{ organizationId?: string }>();
  const { cloud, local } = buildNewSessionSourcePaths(organizationId);

  function navigate(path: Href) {
    router.replace(path);
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="New session" />
      <View className="px-4 pt-4">
        <Text className="mb-3 text-sm font-medium text-muted-foreground">Where to run</Text>
        <View className="overflow-hidden rounded-lg border border-border bg-card">
          <ConfigureRow
            icon={Cloud}
            title={CLOUD_TITLE}
            subtitle={CLOUD_SUBTITLE}
            tone="good"
            onPress={() => {
              navigate(cloud);
            }}
            last={false}
          />
          <ConfigureRow
            icon={Server}
            title={LOCAL_TITLE}
            subtitle={LOCAL_SUBTITLE}
            tone="good"
            onPress={() => {
              navigate(local);
            }}
            last
          />
        </View>
      </View>
    </View>
  );
}
