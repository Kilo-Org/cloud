import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  COMMAND_COUNTER_VISIBLE_REMAINING,
  MAX_SETUP_COMMAND_LENGTH,
} from '@/components/profiles/profile-commands-model';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';

type SetupCommandFieldProps = Readonly<{
  /** The command the caller holds; seeds the field and sizes the hint. */
  command: string;
  /** The field's label, which is also its accessible name. */
  label: string;
  disabled?: boolean;
  accessibilityHint?: string;
  onChangeText: (next: string) => void;
  onEndEditing?: () => void;
  onSubmitEditing?: () => void;
}>;

/**
 * One setup-command text field with the server's per-command bound made
 * visible. The native input clips a longer value (a paste) at
 * `MAX_SETUP_COMMAND_LENGTH` before the change reaches JS, so the field cannot
 * tell a cut from a command that legitimately reaches the bound, and it does
 * not claim one: an ordinary row says nothing, a command within
 * `COMMAND_COUNTER_VISIBLE_REMAINING` of the bound counts the room left, and a
 * command at the bound states what the bound is. The two states never render
 * together: at the bound the count is zero, which the sentence already says.
 */
export function SetupCommandField({
  command,
  label,
  disabled = false,
  accessibilityHint,
  onChangeText,
  onEndEditing,
  onSubmitEditing,
}: Readonly<SetupCommandFieldProps>) {
  const { t } = useTranslation();
  const remaining = MAX_SETUP_COMMAND_LENGTH - command.length;
  // One line at a time: the room left while there is room, the bound once there
  // is none. At zero the count would only restate the sentence below it.
  const showsCounter = !disabled && remaining > 0 && remaining <= COMMAND_COUNTER_VISIBLE_REMAINING;
  const showsBound = !disabled && remaining <= 0;

  return (
    <View className="gap-1.5">
      <FormField
        label={label}
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
        onChangeText={onChangeText}
      />
      {showsCounter ? (
        <View className="flex-row justify-end">
          {/* i18n-dup-ok: 'agentChat.composer.charactersRemaining_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules. */}
          <Text
            className="text-xs font-normal text-muted-foreground"
            accessibilityLabel={t('agentChat.composer.charactersRemaining', { count: remaining })}
          >
            {remaining}
          </Text>
        </View>
      ) : null}
      {showsBound ? (
        <AccessibleStatus
          message={t('profiles.commandAtLimit', { max: MAX_SETUP_COMMAND_LENGTH })}
          tone="status"
          className="text-xs"
        />
      ) : null}
    </View>
  );
}
