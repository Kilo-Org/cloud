import { type Href, useRouter } from 'expo-router';
import { SearchX } from 'lucide-react-native';
import { type ReactNode } from 'react';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type InstanceContextResult } from '@/lib/hooks/use-instance-context';

type Props = {
  context: InstanceContextResult;
  children?: ReactNode;
};

/**
 * Renders the terminal states of `useInstanceContext`: an error with retry,
 * or an "instance not found" empty state (destroyed instance / stale deep
 * link). Renders `children` for `loading`/`ready` — screens keep their own
 * loading skeletons, this only covers the states they used to collapse into
 * an eternal skeleton.
 */
export function InstanceContextBoundary({ context, children }: Readonly<Props>) {
  const router = useRouter();

  if (context.status === 'error') {
    return (
      <View className="flex-1 items-center justify-center">
        <QueryError
          message="Could not load instance"
          onRetry={() => {
            context.refetch();
          }}
        />
      </View>
    );
  }

  if (context.status === 'not_found') {
    return (
      <View className="flex-1 items-center justify-center">
        <EmptyState
          icon={SearchX}
          title="Instance not found"
          description="This instance may have been destroyed, or the link is no longer valid."
          action={
            <Button
              variant="outline"
              onPress={() => {
                router.replace('/(app)/(tabs)/(1_kiloclaw)' as Href);
              }}
            >
              <Text>Back to instances</Text>
            </Button>
          }
        />
      </View>
    );
  }

  return <>{children}</>;
}
