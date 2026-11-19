import { type ReactNode } from 'react';
import { View } from 'react-native';

import { QueryError, type QueryErrorVariant } from '@/components/query-error';

/**
 * The load-failure body of the dismiss sheet's read gates: the sheet header
 * the caller owns, then one centered QueryError. The failure branches of the
 * three gate families (finding, paused, capability) differ only in the copy
 * and the retry target, so one body keeps the gates under the max-lines
 * budget.
 */
export function DismissFindingLoadFailure({
  header,
  message,
  onRetry,
  variant,
}: Readonly<{
  header: ReactNode;
  message: string;
  onRetry: () => void;
  variant?: QueryErrorVariant;
}>) {
  return (
    <View className="flex-1 bg-background">
      {header}
      <QueryError
        // `variant` unset keeps QueryError's own neutral default; forwarding
        // it undefined is equivalent, so no default is decided here.
        {...(variant === undefined ? {} : { variant })}
        message={message}
        onRetry={onRetry}
      />
    </View>
  );
}
