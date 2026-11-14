import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { ChevronDown } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type PickerFieldProps = Readonly<{
  label: string;
  /** The chosen value's text, or null when nothing is chosen yet. */
  value: string | null;
  placeholder: string;
  error?: string | null;
  disabled?: boolean;
  onPress: () => void;
}>;

/**
 * A form field whose value is chosen from a menu rather than typed: the same
 * label, box and error line as `FormField`, with a disclosure control where the
 * input would be.
 */
export function PickerField({
  label,
  value,
  placeholder,
  error,
  disabled,
  onPress,
}: PickerFieldProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const empty = value === null;

  return (
    <View className="gap-1.5">
      <FormFieldLabel label={label} />
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t('ssh.field.value', { label, value: value ?? placeholder })}
        accessibilityState={{ disabled: Boolean(disabled) }}
        className={cn(
          'min-h-[44px] flex-row items-center gap-2 rounded-md border border-input bg-background px-3 active:opacity-70 dark:bg-[#FFFFFF0A]',
          error && 'border-destructive',
          disabled && 'opacity-50'
        )}
      >
        <Text
          className={cn(
            'min-w-0 flex-1 text-sm font-normal',
            empty ? 'text-muted-foreground' : 'text-foreground'
          )}
          numberOfLines={1}
        >
          {value ?? placeholder}
        </Text>
        <View className="size-[18px] shrink-0 items-center justify-center">
          <ChevronDown size={16} color={colors.mutedForeground} />
        </View>
      </Pressable>
      <AccessibleStatus message={error ?? null} className="text-sm" />
    </View>
  );
}
