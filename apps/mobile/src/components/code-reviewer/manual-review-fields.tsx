import { useTranslation } from 'react-i18next';
import { TextInput, View } from 'react-native';

import { formFieldA11y } from '@/components/ui/form-field-a11y';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The URL and instructions fields of the manual-review form. They are split
 * out of `manual-review-screen.tsx` (which is at its max-lines budget) so each
 * field keeps its input rules and its composed accessibility label next to the
 * input it describes, while the screen keeps only the form's control flow.
 */
export function ManualReviewFields({
  urlPlaceholder,
  urlError,
  onUrlChange,
  onInstructionsChange,
}: Readonly<{
  urlPlaceholder: string;
  urlError: string | null;
  onUrlChange: (value: string) => void;
  onInstructionsChange: (value: string) => void;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <>
      <View className="gap-3">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          {t('codeReviewer.manualReview.pullRequestUrl')}
        </Text>
        <Input
          // Remount when the platform (and so the placeholder) changes so the
          // uncontrolled field drops the previous URL; the screen clears
          // `urlRef` on the same platform change.
          key={urlPlaceholder}
          // The shared single-line box supplies the touch floor
          // (`min-h-[44px]`, never a fixed height); the field keeps its
          // own chrome, horizontal inset and line box.
          className="rounded-md border border-input bg-background px-3 text-sm leading-[normal] text-foreground"
          placeholder={urlPlaceholder}
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel={formFieldA11y({
            label: t('codeReviewer.manualReview.pullRequestUrl'),
            error: urlError,
          })}
          onChangeText={onUrlChange}
        />
        {urlError ? <Text className="text-xs text-destructive">{urlError}</Text> : null}
      </View>

      <View className="gap-3">
        <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
          {t('codeReviewer.manualReview.instructions')}
        </Text>
        <TextInput
          className="h-24 rounded-lg bg-secondary p-3 text-sm leading-5 text-foreground"
          multiline
          textAlignVertical="top"
          accessibilityLabel={formFieldA11y({
            label: t('codeReviewer.manualReview.instructions'),
          })}
          placeholder={t('codeReviewer.manualReview.instructionsPlaceholder')}
          placeholderTextColor={colors.mutedForeground}
          onChangeText={onInstructionsChange}
        />
      </View>
    </>
  );
}
