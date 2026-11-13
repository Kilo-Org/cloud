import { View } from 'react-native';

import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type SwitchFieldProps = Readonly<{
  label: string;
  /** One line under the label saying what the switch changes. */
  hint?: string;
  value: boolean;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
}>;

/** A labelled switch row: the label and its hint, with the control at the end. */
export function SwitchField({
  label,
  hint,
  value,
  disabled,
  onValueChange,
}: SwitchFieldProps) {
  return (
    <View className="min-h-[44px] flex-row items-center gap-3">
      <View className="min-w-0 flex-1">
        <Text
          className={cn(
            'text-sm font-medium',
            disabled ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {label}
        </Text>
        {hint === undefined ? null : (
          <Text className="mt-0.5 text-xs text-muted-foreground">{hint}</Text>
        )}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        accessibilityLabel={label}
      />
    </View>
  );
}
