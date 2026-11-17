import { type ReactNode } from 'react';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';

/** What a provider-key save can refuse with: a retryable failure or a refusal. */
export type SaveFailure =
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * One failed save, drawn where the form's submit sits: a retry the person can
 * press, or the reason the request was refused.
 */
export function ProviderKeySaveFailure({
  failure,
  onRetry,
  retryLabel,
}: Readonly<{
  failure: SaveFailure | null;
  onRetry: () => void;
  retryLabel: string;
}>): ReactNode {
  if (!failure) {
    return null;
  }
  switch (failure.kind) {
    case 'retryable':
      return (
        <View className="gap-2">
          <AccessibleStatus message={failure.message} className="text-sm" />
          <Button variant="outline" size="sm" className={STATE_ACTION_CLASS} onPress={onRetry}>
            <Text>{retryLabel}</Text>
          </Button>
        </View>
      );
    case 'refused':
      return <AccessibleStatus message={failure.message} className="text-sm" />;
    default:
      return assertSurfaceFailureHandled(failure);
  }
}