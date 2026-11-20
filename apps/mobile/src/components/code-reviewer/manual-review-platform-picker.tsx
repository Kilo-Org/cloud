import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { RowGroup } from '@/components/ui/row-group';
import { Text } from '@/components/ui/text';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { cn } from '@/lib/utils';

import { MANUAL_REVIEW_PLATFORMS, type ManualReviewPlatform } from './manual-review-platform';

type ManualReviewPlatformPickerProps = {
  platform: ManualReviewPlatform;
  isConnected: (option: ManualReviewPlatform) => boolean;
  onSelect: (option: ManualReviewPlatform) => void;
};

/**
 * The manual-review form's platform radio group. Selecting a platform clears
 * the URL field (the placeholder and validation are platform-shaped), so the
 * picker runs the caller's reset through `onSelect`; `ChoiceRow` owns the
 * selection haptic.
 *
 * The screen replaces this group with `ManualReviewSkeleton` while the provider
 * statuses load, so the group renders the choices only; a second loading shape
 * here would be a placeholder no caller can reach.
 */
export function ManualReviewPlatformPicker({
  platform,
  isConnected,
  onSelect,
}: Readonly<ManualReviewPlatformPickerProps>) {
  const { t } = useTranslation();
  return (
    <RadioGroup label={t('common.platform')}>
      <RowGroup>
        {MANUAL_REVIEW_PLATFORMS.map(option => {
          const connected = isConnected(option);
          const platformLabel = PLATFORM_CAPABILITIES[option].label;
          return (
            <ChoiceRow
              key={option}
              // A disabled radio keeps its reason in its own name: the visible
              // `Not connected` line below is a sibling of the control, not
              // part of it, so a screen reader would otherwise announce the
              // platform and its disabled state with no explanation. The row's
              // children are hidden from accessibility below, so the reason is
              // announced once, from inside the control.
              accessibleName={
                connected ? platformLabel : `${platformLabel}, ${t('common.notConnected')}`
              }
              selected={connected && platform === option}
              disabled={!connected}
              onPress={() => {
                onSelect(option);
              }}
            >
              <View
                // The control above owns this row's accessible name; leaving
                // the visible label and its reason focusable too would read the
                // platform name and the reason a second time.
                className="flex-1"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Text className={cn('text-sm font-medium', !connected && 'text-muted-foreground')}>
                  {platformLabel}
                </Text>
                {!connected && (
                  // The row dims only its label. This line is the only place
                  // that says why the option cannot be picked, so it keeps the
                  // muted token's own 4.5:1 on the row surface instead of
                  // inheriting a row-level opacity that halves it.
                  <Text variant="muted" className="mt-0.5 text-xs">
                    {t('common.notConnected')}
                  </Text>
                )}
              </View>
            </ChoiceRow>
          );
        })}
      </RowGroup>
    </RadioGroup>
  );
}
