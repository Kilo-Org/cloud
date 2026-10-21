import * as Haptics from 'expo-haptics';
import { Check } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const MANUAL_REVIEW_PLATFORMS = ['github', 'gitlab'] as const;
type ManualReviewPlatform = (typeof MANUAL_REVIEW_PLATFORMS)[number];

type ManualReviewPlatformPickerProps = {
  isLoading: boolean;
  platform: ManualReviewPlatform;
  isConnected: (option: ManualReviewPlatform) => boolean;
  onSelect: (option: ManualReviewPlatform) => void;
};

/**
 * The manual-review form's platform radio group. Selecting a platform clears
 * the URL field (the placeholder and validation are platform-shaped), so the
 * picker owns the selection haptic and the caller's reset through `onSelect`.
 */
export function ManualReviewPlatformPicker({
  isLoading,
  platform,
  isConnected,
  onSelect,
}: Readonly<ManualReviewPlatformPickerProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  if (isLoading) {
    return (
      <View className="gap-2">
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
      </View>
    );
  }
  return (
    <RadioGroup label={t('common.platform')} className="overflow-hidden rounded-lg bg-secondary">
      {MANUAL_REVIEW_PLATFORMS.map((option, index) => {
        const connected = isConnected(option);
        return (
          <Pressable
            key={option}
            disabled={!connected}
            className={cn(
              'flex-row items-center justify-between px-4 py-3 active:opacity-70',
              index < MANUAL_REVIEW_PLATFORMS.length - 1 && 'border-b-[0.5px] border-hair-soft',
              !connected && 'opacity-50'
            )}
            onPress={() => {
              void Haptics.selectionAsync();
              onSelect(option);
            }}
            {...radioItemA11y({
              label: PLATFORM_CAPABILITIES[option].label,
              checked: connected && platform === option,
              disabled: !connected,
            })}
          >
            <View>
              <Text className="text-sm font-medium">{PLATFORM_CAPABILITIES[option].label}</Text>
              {!connected && (
                <Text variant="muted" className="text-xs">
                  {t('common.notConnected')}
                </Text>
              )}
            </View>
            <Check
              size={18}
              color={connected && platform === option ? colors.foreground : 'transparent'}
            />
          </Pressable>
        );
      })}
    </RadioGroup>
  );
}
