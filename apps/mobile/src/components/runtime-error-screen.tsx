import { View } from 'react-native';

import { QueryError } from '@/components/query-error';

type RuntimeErrorScreenProps = {
  readonly onRetry: () => void;
};

/**
 * Last-resort screen for a render error that reached the app's root error
 * boundary (expo-router `ErrorBoundary` in `src/app/_layout.tsx`).
 *
 * It owns a plain full-screen layout instead of a measured `StateSurface`: the
 * centering pipeline withholds its content until the native surface observer
 * reports a visible geometry, and a boundary that rendered behind that gate was
 * a blank frame whenever the snapshot never arrived (or arrived with the
 * surface reported invisible). An error screen must paint immediately and
 * must not depend on the machinery that may have just failed.
 */
export function RuntimeErrorScreen({ onRetry }: RuntimeErrorScreenProps) {
  return (
    <View className="flex-1 items-center justify-center bg-background">
      <QueryError placement="static" className="w-full" onRetry={onRetry} />
    </View>
  );
}
