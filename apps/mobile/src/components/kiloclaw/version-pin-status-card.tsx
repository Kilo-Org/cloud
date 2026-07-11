import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  type useKiloClawLatestVersion,
  type useKiloClawMyPin,
} from '@/lib/hooks/use-kiloclaw-queries';

type MyPin = NonNullable<ReturnType<typeof useKiloClawMyPin>['data']>;
type LatestVersion = NonNullable<ReturnType<typeof useKiloClawLatestVersion>['data']>;

export function VersionPinStatusCard({
  myPin,
  latestVersion,
  isPinnedByAdmin,
  isPinMutating,
  isRemovingPin,
  onUnpin,
}: Readonly<{
  myPin: MyPin | null | undefined;
  latestVersion: LatestVersion | null | undefined;
  isPinnedByAdmin: boolean;
  isPinMutating: boolean;
  isRemovingPin: boolean;
  onUnpin: () => void;
}>) {
  return (
    <View className="rounded-lg bg-secondary p-4 min-h-[60px] justify-center gap-2">
      {myPin ? (
        <>
          <View className="flex-row items-center justify-between">
            <View className="flex-1 gap-1">
              <Text className="text-sm font-medium">
                Pinned to {myPin.openclaw_version ?? myPin.image_tag}
              </Text>
              {myPin.reason && (
                <Text variant="muted" className="text-xs">
                  {myPin.reason}
                </Text>
              )}
            </View>
            {!isPinnedByAdmin && (
              <Button
                size="sm"
                variant="outline"
                loading={isRemovingPin}
                disabled={isPinMutating}
                onPress={onUnpin}
              >
                <Text>Unpin</Text>
              </Button>
            )}
          </View>
          {isPinnedByAdmin && (
            <Text className="text-xs text-warn">
              Pinned by admin — contact your admin to change.
            </Text>
          )}
        </>
      ) : (
        <View className="flex-row items-center gap-2">
          <View className="rounded-full bg-good-tile-bg px-2 py-0.5">
            <Text className="text-xs font-medium text-good">Following latest</Text>
          </View>
          {latestVersion && (
            <Text variant="muted" className="text-xs">
              {latestVersion.openclawVersion}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
