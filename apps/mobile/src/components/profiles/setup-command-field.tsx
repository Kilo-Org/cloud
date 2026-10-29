import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  COMMAND_COUNTER_VISIBLE_REMAINING,
  commandClippedByLimit,
  MAX_SETUP_COMMAND_LENGTH,
} from '@/components/profiles/profile-commands-model';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';

type SetupCommandFieldProps = Readonly<{
  /** The command the caller holds; seeds the field and sizes the hint. */
  command: string;
  disabled?: boolean;
  accessibilityHint?: string;
  onChangeText: (next: string) => void;
  onEndEditing?: () => void;
  onSubmitEditing?: () => void;
}>;

/**
 * One setup-command text field with the server's per-command bound made
 * visible. The native input clips a longer value (a paste) at
 * `MAX_SETUP_COMMAND_LENGTH` before the change reaches JS, so an ordinary row
 * is unchanged: nothing renders until the command nears the bound, and the
 * shortened notice appears only for the change that was cut there.
 */
export function SetupCommandField({
  command,
  disabled = false,
  accessibilityHint,
  onChangeText,
  onEndEditing,
  onSubmitEditing,
}: Readonly<SetupCommandFieldProps>) {
  const { t } = useTranslation();
  // The length this field last reported. The native input drops the overflow,
  // so the step into the bound is the only evidence of a clipped paste.
  const lastLengthRef = useRef(command.length);
  const [clipped, setClipped] = useState(false);
  const remaining = MAX_SETUP_COMMAND_LENGTH - command.length;
  const showsCounter = !disabled && remaining <= COMMAND_COUNTER_VISIBLE_REMAINING;
  const showsClipped = !disabled && clipped;

  return (
    <View className="gap-1.5">
      <FormField
        label={t('profiles.commandLabel')}
        defaultValue={command}
        placeholder={t('profiles.commandPlaceholder')}
        className="min-h-[44px] leading-[normal]"
        maxLength={MAX_SETUP_COMMAND_LENGTH}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        accessibilityHint={accessibilityHint}
        disabled={disabled}
        onEndEditing={onEndEditing}
        onSubmitEditing={onSubmitEditing}
        onChangeText={value => {
          setClipped(commandClippedByLimit(lastLengthRef.current, value));
          lastLengthRef.current = value.length;
          onChangeText(value);
        }}
      />
      {showsCounter || showsClipped ? (
        <View className="gap-1">
          {showsCounter ? (
            <View className="flex-row justify-end">
              <Text className="text-xs font-normal text-muted-foreground">
                {t('agentChat.composer.charactersRemaining', { count: remaining })}
              </Text>
            </View>
          ) : null}
          {showsClipped ? (
            <Text className="text-xs text-muted-foreground">
              {t('profiles.commandShortened', { max: MAX_SETUP_COMMAND_LENGTH })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
