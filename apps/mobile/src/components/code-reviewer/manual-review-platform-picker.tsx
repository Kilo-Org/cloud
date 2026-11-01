import { selectionHaptic } from '@/lib/haptics';
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
        const platformLabel = PLATFORM_CAPABILITIES[option].label;
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
              selectionHaptic();
              onSelect(option);
            }}
            {...radioItemA11y({
              // A disabled radio keeps its reason in its own name: the visible
              // `Not connected` line below is a sibling of the control, not
              // part of it, so a screen reader would otherwise announce the
              // platform and its disabled state with no explanation. The row's
              // children are hidden from accessibility below, so the reason is
              // announced once, from inside the control.
              label: connected ? platformLabel : `${platformLabel}, ${t('common.notConnected')}`,
              checked: connected && platform === option,
              disabled: !connected,
            })}
          >
            <View
              // The control above owns this row's accessible name; leaving the
              // visible label and its reason focusable too would read the
              // platform name and the reason a second time.
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text className="text-sm font-medium">{platformLabel}</Text>
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
