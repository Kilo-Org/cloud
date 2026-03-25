import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { useTRPC } from '@/lib/trpc';

export default function HomeScreen() {
  const { signOut } = useAuth();

  const trpc = useTRPC();
  const { data, isLoading, error } = useQuery(trpc.user.getAuthProviders.queryOptions());

  return (
    <View className="flex-1 items-center justify-center gap-6 bg-background px-6">
      <Text variant="h1">Welcome to Kilo!</Text>

      {isLoading && <Text variant="muted">Loading account info...</Text>}

      {error && <Text variant="muted">Failed to load account info</Text>}

      {data?.providers && (
        <View className="gap-2">
          <Text variant="large">Linked accounts</Text>
          {data.providers.map(p => (
            <Text key={`${p.provider}-${p.email}`} variant="muted">
              {p.provider}: {p.email}
            </Text>
          ))}
        </View>
      )}

      <Button
        variant="outline"
        onPress={() => {
          void signOut();
        }}
      >
        <Text>Sign Out</Text>
      </Button>
    </View>
  );
}
