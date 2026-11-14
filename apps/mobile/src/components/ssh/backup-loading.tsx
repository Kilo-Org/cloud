import { View } from 'react-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { BACKUP_COLLECTIONS } from '@/lib/ssh/backup-payload';

export function SshBackupLoading({ exporting }: { exporting: boolean }) {
  return (
    <DetailScreenScrollView className="flex-1" contentContainerClassName="gap-5 px-4 pt-4">
      <View className="gap-1">
        <Skeleton className="h-5 w-full" />
        {exporting ? <Skeleton className="h-5 w-3/4" /> : null}
      </View>
      {exporting ? (
        <View className="gap-3 rounded-xl border border-border bg-card p-4">
          <Skeleton className="h-6 w-40" />
          {BACKUP_COLLECTIONS.map(collection => (
            <View key={collection} className="flex-row justify-between gap-4">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-5 w-5" />
            </View>
          ))}
        </View>
      ) : (
        <View className="gap-1.5">
          <Skeleton className="h-[48px] rounded-md" />
          <Skeleton className="h-10 w-3/4" />
        </View>
      )}
      <View className="gap-1.5">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-[44px] rounded-md" />
        <Skeleton className={exporting ? 'h-10 w-3/4' : 'h-5 w-3/4'} />
      </View>
      {exporting ? (
        <View className="gap-1.5">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-[44px] rounded-md" />
          <Skeleton className="h-5 w-3/4" />
        </View>
      ) : null}
      <Skeleton className="h-[48px] rounded-md" />
    </DetailScreenScrollView>
  );
}
