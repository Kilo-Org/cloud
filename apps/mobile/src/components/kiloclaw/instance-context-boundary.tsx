import { type Href, useRouter } from 'expo-router';
import { SearchX } from 'lucide-react-native';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type InstanceContextResult } from '@/lib/hooks/use-instance-context';

type Props = {
  title: string;
  context: InstanceContextResult;
};

/**
 * Renders the full-screen shell (background + `ScreenHeader`) for the
 * terminal states of `useInstanceContext`: an error with retry, or an
 * "instance not found" empty state (destroyed instance / stale deep link).
 * Callers only reach this for `error`/`not_found` — `loading`/`ready` are
 * handled by the screen itself.
 */
export function InstanceContextBoundary({ title, context }: Readonly<Props>) {
  const router = useRouter();

  if (context.status === 'error') {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={title} />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message="Could not load instance"
            onRetry={() => {
              context.refetch();
            }}
          />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} />
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
    </View>
  );
}
