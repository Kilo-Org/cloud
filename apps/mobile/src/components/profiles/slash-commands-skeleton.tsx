import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

/** Content-shaped rows in the same slots as a loaded command row. */
export function SlashCommandsSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <Skeleton key={index} className="h-24 w-full rounded-lg bg-muted-soft" />
      ))}
    </View>
  );
}
