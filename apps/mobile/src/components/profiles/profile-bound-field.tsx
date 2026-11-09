import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { PROFILE_DESCRIPTION_MAX_LENGTH, PROFILE_NAME_MAX_LENGTH } from '@/lib/agent-profile-forms';

/**
 * The name and description fields every profile form shares, with the server's
 * character bound made visible. The native input clips a longer value — a paste
 * — at the bound before the change reaches JS, so the field cannot tell a cut
 * from a value that legitimately reaches the bound, and it does not claim one:
 * an ordinary value says nothing, a value within the last tenth of the bound
 * counts the room left, and a value at the bound states what the bound is. A
 * known error already names what is wrong, so it replaces the count line.
 *
 * The text stays in the caller's ref and only its length is state, per the
 * app's iOS text-input rule.
 */
type BoundProfileFieldProps = Readonly<{
  label: string;
  placeholder: string;
  max: number;
  defaultValue: string;
  error?: string | undefined;
  disabled?: boolean | undefined;
  autoCorrect?: boolean | undefined;
  multiline?: boolean | undefined;
  required?: boolean | undefined;
  className?: string | undefined;
  onChangeText: (value: string) => void;
}>;

function BoundProfileField({
  label,
  placeholder,
  max,
  defaultValue,
  error,
  disabled = false,
  autoCorrect,
  multiline,
  required,
  className,
  onChangeText,
}: BoundProfileFieldProps) {
  const { t } = useTranslation();
  const [length, setLength] = useState(defaultValue.length);
  const remaining = max - length;
  // The last tenth of the bound, the stretch the other bounded fields use.
  const counterFrom = Math.max(1, Math.round(max / 10));
  const hasError = error !== undefined && error.length > 0;
  const showsCounter = !disabled && !hasError && remaining > 0 && remaining <= counterFrom;
  const boundMessage =
    disabled || hasError || remaining > 0 ? null : t('profiles.tooLong', { max });

  return (
    <View className="gap-1">
      <FormField
        label={label}
        placeholder={placeholder}
        defaultValue={defaultValue}
        error={error}
        disabled={disabled}
        required={required}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : undefined}
        className={className}
        autoCorrect={autoCorrect}
        maxLength={max}
        onChangeText={value => {
          setLength(value.length);
          onChangeText(value);
        }}
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
      {boundMessage === null ? null : (
        <AccessibleStatus message={boundMessage} tone="status" className="text-xs" />
      )}
    </View>
  );
}

type ProfileFieldProps = Readonly<{
  defaultValue?: string | undefined;
  error?: string | undefined;
  disabled?: boolean | undefined;
  autoCorrect?: boolean | undefined;
  onChangeText: (value: string) => void;
}>;

/** The profile name field; the server keeps it to {@link PROFILE_NAME_MAX_LENGTH}. */
export function ProfileNameField({
  defaultValue = '',
  error,
  disabled,
  autoCorrect,
  onChangeText,
}: ProfileFieldProps) {
  const { t } = useTranslation();

  return (
    <BoundProfileField
      label={t('profiles.nameLabel')}
      placeholder={t('profiles.namePlaceholder')}
      max={PROFILE_NAME_MAX_LENGTH}
      defaultValue={defaultValue}
      error={error}
      disabled={disabled}
      autoCorrect={autoCorrect}
      required
      onChangeText={onChangeText}
    />
  );
}

/** The profile description field; the server keeps it to {@link PROFILE_DESCRIPTION_MAX_LENGTH}. */
export function ProfileDescriptionField({
  defaultValue = '',
  error,
  disabled,
  autoCorrect,
  onChangeText,
}: ProfileFieldProps) {
  const { t } = useTranslation();

  return (
    <BoundProfileField
      label={t('profiles.descriptionLabel')}
      placeholder={t('profiles.descriptionPlaceholder')}
      max={PROFILE_DESCRIPTION_MAX_LENGTH}
      defaultValue={defaultValue}
      error={error}
      disabled={disabled}
      autoCorrect={autoCorrect}
      multiline
      className="min-h-20 leading-[1.25rem]"
      onChangeText={onChangeText}
    />
  );
}
