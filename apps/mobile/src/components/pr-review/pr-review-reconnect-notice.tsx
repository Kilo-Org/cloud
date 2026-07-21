import { useQueryClient } from '@tanstack/react-query';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useTRPC } from '@/lib/trpc';

/**
 * Shared reconnect affordance for PR Review surfaces. A
 * PRECONDITION_FAILED on a query or mutation means the gate's GitHub
 * authorization is no longer valid even though the gate passed. We
 * force a refetch of the gate's query so the wrapping
 * `PrReviewConnectGate` renders its own connect/reconnect CTA. The
 * caller owns section/tab framing; this component is just the
 * message + button.
 */
export function PrReviewReconnectNotice() {
  const queryClient = useQueryClient();
  const trpc = useTRPC();

  const handleReconnect = () => {
    void queryClient.invalidateQueries({
      queryKey: trpc.githubApps.getUserAuthorization.queryKey(),
    });
  };

  return (
    <View className="gap-3 rounded-lg bg-secondary p-4">
      <Text className="text-sm font-medium text-foreground">GitHub connection expired</Text>
      <Text className="text-sm text-muted-foreground">
        Your GitHub connection is no longer valid. Re-check your connection — you&apos;ll be
        prompted to reconnect if needed.
      </Text>
      <Button variant="outline" onPress={handleReconnect} accessibilityLabel="Check connection">
        <Text>Check connection</Text>
      </Button>
    </View>
  );
}
