import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import {
  type AllowedMergeMethod,
  prMergeDescription,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import { type MergeMethodOption } from '@/components/pr-review/merge/pr-merge-icons';

export function MethodPicker({
  methodOptions,
  method,
  isDisabled,
  onChange,
}: Readonly<{
  methodOptions: MergeMethodOption[];
  method: AllowedMergeMethod;
  isDisabled: boolean;
  onChange: (next: AllowedMergeMethod) => void;
}>) {
  const { t } = useTranslation();
  return (
    <View className="gap-1.5">
      {/* Same label style as the sheet's commit-title and commit-message
          fields: the control below is a form field, not a section heading. */}
      <Text className="text-sm font-medium text-foreground">{t('prReview.merge.methodLabel')}</Text>
      {/* Each segment shows the method name alone and announces the full
          sentence the provider words the method with. */}
      <SegmentedControl
        accessibilityLabel={t('prReview.merge.methodLabel')}
        options={methodOptions.map(option => ({
          value: option.value,
          label: option.label,
          accessibilityLabel: option.accessibilityLabel,
          accessibilityHint: prMergeDescription(option.value),
        }))}
        value={method}
        onChange={onChange}
        disabled={isDisabled}
      />
    </View>
  );
}
