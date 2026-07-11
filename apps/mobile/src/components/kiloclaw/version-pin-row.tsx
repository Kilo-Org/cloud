import { Check } from 'lucide-react-native';
import { TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { type useKiloClawAvailableVersions } from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseTimestamp, timeAgo } from '@/lib/utils';

export type VersionItem = NonNullable<
  ReturnType<typeof useKiloClawAvailableVersions>['data']
>['items'][number];

export function VersionPinRow({
  item,
  isPinned,
  isLatest,
  isDraftOpen,
  isPinMutating,
  isConfirmingThis,
  isPinnedByAdmin,
  adminPinLabel,
  onToggle,
  onFocusReason,
  onReasonChange,
  onConfirm,
}: Readonly<{
  item: VersionItem;
  isPinned: boolean;
  isLatest: boolean;
  isDraftOpen: boolean;
  isPinMutating: boolean;
  isConfirmingThis: boolean;
  isPinnedByAdmin: boolean;
  adminPinLabel: string | null;
  onToggle: () => void;
  onFocusReason: () => void;
  onReasonChange: (val: string) => void;
  onConfirm: () => void;
}>) {
  const colors = useThemeColors();
  const publishedAgo = item.published_at ? timeAgo(parseTimestamp(item.published_at)) : undefined;
  const showVariant = item.variant && item.variant !== 'default';

  return (
    <View>
      <View className="flex-row items-center gap-3 py-3">
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-2">
            <Text className="text-sm font-medium">{item.openclaw_version}</Text>
            {isLatest && (
              <View className="rounded-full bg-info px-1.5 py-0.5">
                <Text className="text-[10px] font-semibold text-info-foreground">latest</Text>
              </View>
            )}
          </View>
          {Boolean(publishedAgo ?? showVariant) && (
            <Text variant="muted" className="text-xs">
              {[publishedAgo, showVariant ? item.variant : null].filter(Boolean).join(' · ')}
            </Text>
          )}
        </View>
        {isPinned ? (
          <Check size={18} color={colors.foreground} />
        ) : (
          <Button
            size="sm"
            variant={isDraftOpen ? 'default' : 'outline'}
            disabled={isPinMutating}
            onPress={onToggle}
          >
            <Text>{isDraftOpen ? 'Cancel' : 'Pin'}</Text>
          </Button>
        )}
      </View>
      {isDraftOpen && (
        <Animated.View entering={FadeIn.duration(150)} className="border-t border-border">
          <View className="py-3 gap-3">
            <Text className="text-xs font-medium text-muted-foreground">Reason (optional)</Text>
            <TextInput
              className="rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground"
              placeholder="Why are you pinning this version?"
              placeholderTextColor={colors.mutedForeground}
              onFocus={onFocusReason}
              onChangeText={val => {
                if (val.length <= 500) {
                  onReasonChange(val);
                }
              }}
              autoCapitalize="sentences"
              autoCorrect
              multiline
              maxLength={500}
              editable={!isConfirmingThis}
              accessibilityState={{ busy: isConfirmingThis }}
            />
            {isPinnedByAdmin && adminPinLabel && (
              <Text className="text-xs text-warn">
                This replaces the admin-set pin (currently {adminPinLabel}).
              </Text>
            )}
            <Button
              size="sm"
              loading={isConfirmingThis}
              disabled={isPinMutating}
              onPress={onConfirm}
            >
              {!isConfirmingThis && <Check size={14} color={colors.primaryForeground} />}
              <Text className="text-xs text-primary-foreground">
                {isPinnedByAdmin ? 'Replace Admin Pin' : 'Confirm Pin'}
              </Text>
            </Button>
          </View>
        </Animated.View>
      )}
    </View>
  );
}
