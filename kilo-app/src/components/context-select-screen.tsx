import { useQuery } from '@tanstack/react-query';
import { Building2, User } from 'lucide-react-native';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import logo from '@/../assets/images/logo.png';
import { Button } from '@/components/ui/button';
import { Image } from '@/components/ui/image';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAppContext } from '@/lib/context/context-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';

export function ContextSelectScreen() {
  const { setContext } = useAppContext();
  const trpc = useTRPC();
  const { data, isLoading, error, refetch } = useQuery(trpc.organizations.list.queryOptions());
  const colors = useThemeColors();

  const handlePersonal = () => {
    void setContext({ type: 'personal' });
  };

  const handleOrganization = (organizationId: string) => {
    void setContext({ type: 'organization', organizationId });
  };

  return (
    <View className="flex-1 items-center justify-center gap-8 bg-background px-6">
      <View className="items-center gap-3">
        <Image source={logo} className="h-16 w-16" accessibilityLabel="Kilo logo" />
        <Text variant="h2">Choose Context</Text>
        <Text variant="muted">Select which workspace to use</Text>
      </View>

      <Animated.View className="w-full max-w-sm gap-3" layout={LinearTransition}>
        <Button
          size="lg"
          variant="outline"
          className="flex-row gap-2"
          onPress={handlePersonal}
          accessibilityLabel="Use personal workspace"
        >
          <User size={18} color={colors.foreground} />
          <Text>Personal</Text>
        </Button>

        {isLoading && (
          <Animated.View className="gap-3" exiting={FadeOut.duration(150)}>
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-11 w-full rounded-md" />
          </Animated.View>
        )}

        {error && (
          <View className="items-center gap-2">
            <Text className="text-sm text-destructive">Failed to load organizations</Text>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => {
                void refetch();
              }}
              accessibilityLabel="Retry loading organizations"
            >
              <Text>Retry</Text>
            </Button>
          </View>
        )}

        {data?.map(org => (
          <Animated.View key={org.organizationId} entering={FadeIn.duration(200)}>
            <Button
              size="lg"
              variant="outline"
              className="flex-row gap-2"
              onPress={() => {
                handleOrganization(org.organizationId);
              }}
              accessibilityLabel={`Use ${org.organizationName} workspace`}
            >
              <Building2 size={18} color={colors.foreground} />
              <Text>{org.organizationName}</Text>
            </Button>
          </Animated.View>
        ))}
      </Animated.View>
    </View>
  );
}
