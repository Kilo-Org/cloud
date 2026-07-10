import { type Href, useRouter } from 'expo-router';
import { SearchX } from 'lucide-react-native';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

/**
 * Terminal state for a route whose params fail runtime validation (bad
 * scope/platform/id, or an unsupported scope+platform combination) —
 * matches the "instance not found" pattern in instance-context-boundary.tsx.
 */
export function InvalidRouteState({ backTo }: Readonly<{ backTo: Href }>) {
  const router = useRouter();

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <EmptyState
        icon={SearchX}
        title="Page not found"
        description="This link is no longer valid."
        action={
          <Button
            variant="outline"
            onPress={() => {
              router.replace(backTo);
            }}
          >
            <Text>Go back</Text>
          </Button>
        }
      />
    </View>
  );
}
