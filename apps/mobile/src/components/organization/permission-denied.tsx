import { useRouter } from 'expo-router';
import { Lock } from 'lucide-react-native';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type PermissionDeniedProps = Readonly<{
  description: string;
}>;

/**
 * Shown in place of a privileged form when the signed-in role can't perform
 * the action — e.g. reached by a deep link or stale state rather than
 * through the (role-gated) entry point that would normally hide it.
 */
export function PermissionDenied({ description }: PermissionDeniedProps) {
  const router = useRouter();

  return (
    <View className="flex-1 bg-background">
      <EmptyState
        icon={Lock}
        title="Access denied"
        description={description}
        action={
          <Button
            variant="outline"
            onPress={() => {
              router.back();
            }}
          >
            <Text>Back</Text>
          </Button>
        }
      />
    </View>
  );
}
