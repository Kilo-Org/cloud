import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';

export function PlatformErrorScreen({
  title,
  onRetry,
  isRetrying,
}: Readonly<{ title: string; onRetry: () => void; isRetrying: boolean }>) {
  const paddingBottom = useTabBarBottomPadding();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} eyebrow="Code Reviewer" />
      <View className="flex-1" style={{ paddingBottom }}>
        <QueryError variant="server" onRetry={onRetry} isRetrying={isRetrying} />
      </View>
    </View>
  );
}
