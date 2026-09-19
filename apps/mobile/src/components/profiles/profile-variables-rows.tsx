import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Switch, View } from 'react-native';

import {
  validateVariableInput,
  type VariableEdit,
  type VariableInputError,
  type VariableRow,
} from '@/components/profiles/profile-variables-model';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Eye, EyeOff, Lock, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { cleanVariableKey } from '@/lib/agent-profile-forms';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** Content-shaped rows in the same slot and height as a loaded variable row. */
export function VariablesSkeleton() {
  return (
    <View className="gap-2">
      {[0, 1, 2].map(index => (
        <Skeleton key={index} className="h-14 w-full rounded-lg bg-muted-soft" />
      ))}
    </View>
  );
}

/**
 * Inline edit copy for a refused input. Both cases are refused before a save is
 * attempted, so neither uses the screen's save-failed fallback: an empty key is
 * required, and an over-long key states the server's 256-character bound.
 */
function variableInputErrorMessage(t: (key: string) => string, error: VariableInputError): string {
  return error === 'empty' ? t('common.required') : t('profiles.keyTooLong');
}

/**
 * The empty value field's copy, mirroring the web editor: editing a stored
 * secret asks for a new value to rotate it, a new variable marked secret says
 * the value will be encrypted, and every non-secret value field reads "Value".
 */
function valueFieldPlaceholder(
  t: (key: string) => string,
  isSecret: boolean,
  isNew: boolean
): string {
  if (!isSecret) {
    return t('profiles.valueLabel');
  }
  return isNew ? t('profiles.secrets.valuePlaceholder') : t('profiles.secrets.newValuePlaceholder');
}

type VariableRowViewProps = Readonly<{
  row: VariableRow;
  /**
   * Optional row-level reveal. The profile Variables screen omits it so a
   * secret is only ever revealed from the edit form; the draft editors pass it
   * so a value the user is still composing can be checked.
   */
  revealed?: boolean;
  isDeleting?: boolean;
  onToggleReveal?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}>;

/**
 * One variable row: the key in mono and the value. A secret never renders its
 * stored value — the server sends `***`, and the row shows the dot run instead.
 * When the caller passes `onToggleReveal`, the row offers a reveal control;
 * otherwise a secret stays masked.
 */
export function VariableRowView({
  row,
  revealed = false,
  isDeleting = false,
  onToggleReveal,
  onEdit,
  onDelete,
}: VariableRowViewProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="min-h-14 flex-row items-center gap-1 rounded-lg bg-secondary pr-1 pl-3">
      <Pressable
        className="min-h-14 flex-1 flex-row items-center gap-2 py-2 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={row.key}
        onPress={onEdit}
      >
        <Text className="flex-1 font-mono text-sm text-foreground" numberOfLines={1}>
          {row.key}
        </Text>
        {row.isSecret && onToggleReveal === undefined ? (
          <View className="flex-row items-center gap-1">
            <Lock size={12} color={colors.mutedForeground} />
            <Text
              className="max-w-[45%] text-xs text-muted-foreground"
              numberOfLines={1}
              accessibilityLabel={t('profiles.secrets.masked')}
            >
              {row.maskedValue}
            </Text>
          </View>
        ) : (
          <Text className="max-w-[45%] text-xs text-muted-foreground" numberOfLines={1}>
            {revealed ? row.value : row.maskedValue}
          </Text>
        )}
      </Pressable>
      {row.isSecret && onToggleReveal !== undefined ? (
        <Pressable
          className="h-11 w-11 items-center justify-center active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={t('profiles.secretLabel')}
          accessibilityState={{ selected: revealed }}
          onPress={onToggleReveal}
        >
          {revealed ? (
            <EyeOff size={18} color={colors.mutedForeground} />
          ) : (
            <Eye size={18} color={colors.mutedForeground} />
          )}
        </Pressable>
      ) : null}
      <Pressable
        className="h-11 w-11 items-center justify-center active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={t('common.delete')}
        disabled={isDeleting}
        accessibilityState={{ disabled: isDeleting }}
        onPress={onDelete}
      >
        <Trash2 size={18} color={colors.destructive} />
      </Pressable>
    </View>
  );
}

type VariableEditFormProps = Readonly<{
  isNew: boolean;
  initial: VariableEdit;
  isSaving: boolean;
  onCancel: () => void;
  onSave: (edit: VariableEdit) => Promise<boolean>;
}>;

/**
 * The inline add/edit form. Uncontrolled fields read through refs; `hasValue`
 * is derived UI only, so the Save button disables until a secret edit has a new
 * value to store (the server returns a masked `***`, which must not be saved
 * back). A failed save leaves the form mounted with the typed values.
 */
export function VariableEditForm({
  isNew,
  initial,
  isSaving,
  onCancel,
  onSave,
}: VariableEditFormProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const keyRef = useRef(initial.key);
  const valueRef = useRef(initial.value);
  const [isSecret, setIsSecret] = useState(initial.isSecret);
  const [revealed, setRevealed] = useState(false);
  const [hasValue, setHasValue] = useState(initial.value.trim().length > 0);
  const [error, setError] = useState<VariableInputError | null>(null);

  const canSave = !isSecret || hasValue;
  const valuePlaceholder = valueFieldPlaceholder(t, isSecret, isNew);

  const submit = async () => {
    const key = keyRef.current;
    if (isNew) {
      const invalid = validateVariableInput({ key, value: valueRef.current });
      if (invalid !== null) {
        setError(invalid);
        return;
      }
    }
    setError(null);
    await onSave({
      key: isNew ? cleanVariableKey(key.trim()) : initial.key,
      value: valueRef.current,
      isSecret,
    });
  };

  return (
    <View className="gap-3 rounded-lg border border-border bg-card p-3">
      <FormField
        label={t('profiles.keyLabel')}
        defaultValue={initial.key}
        disabled={!isNew}
        required
        autoCapitalize="characters"
        autoCorrect={false}
        error={error === null ? undefined : variableInputErrorMessage(t, error)}
        onChangeText={value => {
          keyRef.current = value;
          if (error !== null) {
            setError(validateVariableInput({ key: value, value: valueRef.current }));
          }
        }}
      />
      <FormField
        label={t('profiles.valueLabel')}
        placeholder={valuePlaceholder}
        defaultValue={initial.value}
        secureTextEntry={isSecret && !revealed}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={value => {
          valueRef.current = value;
          setHasValue(value.trim().length > 0);
        }}
      />
      {isSecret ? (
        <Pressable
          className="min-h-11 flex-row items-center gap-2 self-start px-1 active:opacity-70"
          accessibilityRole="button"
          accessibilityLabel={t('profiles.secrets.reveal')}
          accessibilityState={{ selected: revealed }}
          onPress={() => {
            setRevealed(current => !current);
          }}
        >
          {revealed ? (
            <EyeOff size={18} color={colors.mutedForeground} />
          ) : (
            <Eye size={18} color={colors.mutedForeground} />
          )}
          <Text className="text-sm text-muted-foreground">{t('profiles.secrets.reveal')}</Text>
        </Pressable>
      ) : null}
      <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
        <Lock size={18} color={colors.secondaryForeground} />
        <Text className="flex-1 text-sm font-medium text-foreground">
          {t('profiles.secrets.markSecret')}
        </Text>
        <Switch
          value={isSecret}
          accessibilityLabel={t('profiles.secrets.markSecret')}
          onValueChange={setIsSecret}
        />
      </View>
      <View className="flex-row gap-2">
        <Button variant="outline" className="flex-1" onPress={onCancel}>
          <Text>{t('common.cancel')}</Text>
        </Button>
        <Button
          className="flex-1"
          loading={isSaving}
          disabled={!canSave || isSaving}
          onPress={() => {
            void submit();
          }}
        >
          <Text>{t('common.save')}</Text>
        </Button>
      </View>
    </View>
  );
}
