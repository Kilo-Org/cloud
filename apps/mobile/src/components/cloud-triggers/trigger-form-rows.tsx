/**
 * The two row shapes the trigger form is built from beside its text fields: a
 * row that opens a picker with the value it currently holds, and a row that
 * carries a switch.
 *
 * Both are the shared row primitives rather than a local row anatomy, so the
 * form's rows start their text at the same x and are the same height as every
 * other row in the app.
 */

import { View } from 'react-native';

import { ChevronDown } from '@/components/ui/icons';
import { PreferenceRow } from '@/components/ui/preference-row';
import { RowFrame } from '@/components/ui/row-frame';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type TriggerSelectRowProps = Readonly<{
  label: string;
  value: string;
  onPress: () => void;
  disabled?: boolean;
  /** Overrides the composed accessible name when the value alone is not the whole story. */
  accessibilityLabel?: string;
  /** A message the row could not apply the choice, shown under it. */
  error?: string;
}>;

export function TriggerSelectRow({
  label,
  value,
  onPress,
  disabled = false,
  accessibilityLabel,
  error,
}: TriggerSelectRowProps) {
  const colors = useThemeColors();
  return (
    <View>
      <RowFrame
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityValue={{ text: value }}
        disabled={disabled}
        onPress={onPress}
        leading={
          <Text variant="muted" className="shrink-0">
            {label}
          </Text>
        }
        // The caret names the picker this row opens; it is a disclosure mark,
        // not a navigation chevron, so it keeps its own glyph.
        trailing={{
          kind: 'node',
          node: (
            <View className="min-w-0 shrink flex-row items-center justify-end gap-2">
              <Text
                numberOfLines={1}
                className={cn(
                  'min-w-0 text-right text-sm font-medium',
                  disabled ? 'text-muted-foreground' : 'text-foreground'
                )}
              >
                {value}
              </Text>
              <ChevronDown size={16} color={colors.mutedForeground} />
            </View>
          ),
        }}
      />
      {error === undefined ? null : <Text className="pb-1 text-xs text-destructive">{error}</Text>}
    </View>
  );
}

type TriggerSwitchRowProps = Readonly<{
  title: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}>;

export function TriggerSwitchRow({
  title,
  description,
  value,
  onValueChange,
  disabled = false,
}: TriggerSwitchRowProps) {
  return (
    <PreferenceRow
      title={title}
      subtitle={description}
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
    />
  );
}
