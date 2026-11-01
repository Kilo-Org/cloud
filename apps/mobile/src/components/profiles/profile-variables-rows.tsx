import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import {
  savedVariableKey,
  validateVariableInput,
  type VariableEdit,
  type VariableInputError,
  variableKeyPreview,
  type VariableRow,
} from '@/components/profiles/profile-variables-model';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Eye, EyeOff, Lock, Trash2 } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { ICON_TARGET_BOX_CLASS, ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useFormDraftRef, useFormDraftState } from '@/lib/form-draft';
import { cn } from '@/lib/utils';

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
 * Inline edit copy for a refused input. Every case is refused before a save is
 * attempted, so none uses the screen's save-failed fallback: an empty key is
 * required, an over-long key states the server's 256-character bound, a key
 * that cleans onto an existing one says so instead of silently overwriting it,
 * and a blank value is refused rather than saved as an empty variable.
 */
function variableInputErrorMessage(t: (key: string) => string, error: VariableInputError): string {
  if (error === 'empty') {
    return t('common.required');
  }
  if (error === 'value-required') {
    return t('profiles.valueRequired');
  }
  return error === 'duplicate' ? t('profiles.keyDuplicate') : t('profiles.keyTooLong');
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
  onEdit?: () => void;
  onDelete?: () => void;
}>;

/**
 * One variable row: the key in mono and the value. A secret never renders its
 * stored value — the server sends `***`, and the row shows the dot run instead.
 * When the caller passes `onToggleReveal`, the row offers a reveal control that
 * names the action it performs now: it reads "Reveal value" while the value is
 * masked and "Hide value" while it is shown. Otherwise a secret stays masked.
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
  const revealLabel = revealed ? t('profiles.secrets.hide') : t('profiles.secrets.reveal');
  return (
    <View className="min-h-14 flex-row items-center gap-1 rounded-lg bg-secondary pr-1 pl-3">
      <Pressable
        className="min-h-14 flex-1 flex-row items-center gap-2 py-2 active:opacity-70"
        accessibilityRole="button"
        accessibilityLabel={row.key}
        disabled={onEdit === undefined}
        onPress={onEdit}
      >
        {/* Middle ellipsis: keys in one profile share long prefixes, so a tail
            cut made neighbouring rows look identical. A key can be up to 256
            characters and never fits a compact row, and Android middle-truncates
            single-line text only, so this keeps both ends visible in one line
            instead of wrapping. */}
        <Text
          className="flex-1 font-mono text-sm text-foreground"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {row.key}
        </Text>
        {row.isSecret && onToggleReveal === undefined ? (
          // The mask is a fixed run of dots, so it never truncates: a clipped
          // mask reads as a cut-off value instead of a hidden one.
          <View className="flex-row items-center gap-1">
            <Lock size={12} color={colors.mutedForeground} />
            <Text
              className="text-xs text-muted-foreground"
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
          className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={revealLabel}
          onPress={onToggleReveal}
        >
          {revealed ? (
            <EyeOff size={18} color={colors.mutedForeground} />
          ) : (
            <Eye size={18} color={colors.mutedForeground} />
          )}
        </Pressable>
      ) : null}
      {onDelete !== undefined ? (
        <Pressable
          className={cn(ICON_TARGET_BOX_CLASS, 'active:opacity-70')}
          accessibilityRole="button"
          accessibilityLabel={t('profiles.deleteVariable', { key: row.key })}
          disabled={isDeleting}
          accessibilityState={{ disabled: isDeleting }}
          onPress={onDelete}
        >
          <Trash2 size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}

type VariableEditFormProps = Readonly<{
  isNew: boolean;
  initial: VariableEdit;
  /**
   * The form draft the fields belong to (see `lib/form-draft`). A screen passes
   * a scope scoped to its profile so the typed key, value and secret survive a
   * remount; a caller that owns no draft leaves it out and gets fresh fields
   * every mount.
   */
  draftScope?: string;
  /**
   * The profile's stored keys, so a new key that cleans onto an existing one is
   * refused rather than silently overwriting it (the server upserts on
   * `(profile_id, key)`). Ignored for an edit, whose key is fixed.
   */
  existingKeys?: readonly string[];
  isSaving: boolean;
  /**
   * Refuse a blank value with an inline message. The profile Variables screen
   * asks for it; the new-session draft editor leaves it off, because
   * prepare-session accepts an empty value and the web editor saves it too.
   */
  requireValue?: boolean;
  /**
   * The bound the value must satisfy, when the caller's target is stricter
   * than the profile's own 10000-character server cap. The manual session
   * editor passes the prepare-session limit, so an over-long value is not
   * typeable in the first place.
   */
  maxValueLength?: number;
  onCancel: () => void;
  onSave: (edit: VariableEdit) => Promise<boolean>;
}>;

/**
 * The inline add/edit form. Uncontrolled fields read through refs. When
 * `requireValue` is set, Save refuses a blank value and says so under the Value
 * field instead of leaving a disabled button that reports nothing; a stored
 * secret's masked `***` is never seeded, so a secret edit needs a new value. A
 * failed save leaves the form mounted with the typed values. A new key is
 * normalized on save (upper case, `A-Z0-9_` only), so the form names the key it
 * will store under the field whenever that differs from what was typed.
 */
export function VariableEditForm({
  isNew,
  initial,
  draftScope,
  existingKeys = [],
  isSaving,
  requireValue = false,
  maxValueLength,
  onCancel,
  onSave,
}: VariableEditFormProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  // A caller that passes no draft scope gets plain per-mount fields, so a form
  // that must start empty, such as the new-session config, never inherits the
  // text of the last time it was opened.
  const keyRef = useFormDraftRef(draftScope, 'key', initial.key);
  const valueRef = useFormDraftRef(draftScope, 'value', initial.value);
  const [isSecret, setIsSecret] = useFormDraftState(draftScope, 'isSecret', initial.isSecret);
  const [revealed, setRevealed] = useFormDraftState(draftScope, 'revealed', false);
  const [error, setError] = useState<VariableInputError | null>(null);
  // The key a save will store, when it differs from what the field holds. An
  // edit keeps its stored key, so only an add can change it.
  const [keyPreview, setKeyPreview] = useState<string | null>(() =>
    isNew ? variableKeyPreview(keyRef.current) : null
  );

  const valuePlaceholder = valueFieldPlaceholder(t, isSecret, isNew);
  // The reveal control names what pressing it does next: it hides the value it
  // is showing, and reveals the one it is masking.
  const revealLabel = revealed ? t('profiles.secrets.hide') : t('profiles.secrets.reveal');
  // An edit's key is stored, so only an add can collide with the profile's keys.
  const validate = (key: string, value: string): VariableInputError | null =>
    validateVariableInput({ key, value }, isNew ? existingKeys : [], { requireValue });

  const submit = async () => {
    const key = keyRef.current;
    const invalid = validate(key, valueRef.current);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    setError(null);
    await onSave({
      key: isNew ? savedVariableKey(key) : initial.key,
      value: valueRef.current,
      isSecret,
    });
  };

  return (
    <View className="gap-3 rounded-lg border border-border bg-card p-3">
      <View className="gap-1.5">
        <FormField
          label={t('profiles.keyLabel')}
          defaultValue={keyRef.current}
          disabled={!isNew}
          required
          autoCapitalize="characters"
          autoCorrect={false}
          error={
            error === null || error === 'value-required'
              ? undefined
              : variableInputErrorMessage(t, error)
          }
          onChangeText={value => {
            keyRef.current = value;
            if (isNew) {
              setKeyPreview(variableKeyPreview(value));
            }
            if (error !== null && error !== 'value-required') {
              setError(validate(value, valueRef.current));
            }
          }}
        />
        {keyPreview === null ? null : (
          <Text className="text-xs text-muted-foreground">
            {t('profiles.keyWillBeSavedAs', { key: keyPreview })}
          </Text>
        )}
      </View>
      <FormField
        label={t('profiles.valueLabel')}
        placeholder={valuePlaceholder}
        defaultValue={valueRef.current}
        maxLength={maxValueLength}
        secureTextEntry={isSecret && !revealed}
        autoCapitalize="none"
        autoCorrect={false}
        error={error === 'value-required' ? variableInputErrorMessage(t, error) : undefined}
        onChangeText={value => {
          valueRef.current = value;
          if (error === 'value-required') {
            setError(validate(keyRef.current, value));
          }
        }}
      />
      {isSecret ? (
        <Pressable
          className={cn(
            ROW_TARGET_CLASS,
            'flex-row items-center gap-2 self-start px-1 active:opacity-70'
          )}
          accessibilityRole="button"
          accessibilityLabel={revealLabel}
          onPress={() => {
            setRevealed(current => !current);
          }}
        >
          {revealed ? (
            <EyeOff size={18} color={colors.mutedForeground} />
          ) : (
            <Eye size={18} color={colors.mutedForeground} />
          )}
          <Text className="text-sm text-muted-foreground">{revealLabel}</Text>
        </Pressable>
      ) : null}
      <View
        className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 rounded-lg bg-secondary p-3')}
      >
        <Lock size={18} color={colors.secondaryForeground} />
        <Text className="flex-1 text-sm font-medium text-foreground">
          {t('profiles.secrets.markSecret')}
        </Text>
        {/* The native switch draws its 32dp track inside a box that reserves the
            thumb's overhang, so the track ends about 12dp before the box does
            and the row's 10.5dp padding leaves it 23dp from the row's edge,
            twice the 13dp the lock glyph keeps from its opposite edge. Pulling
            the box out by the padding itself lines the track's end up with the
            glyph on both edges. The pull is on the END edge, so it must stay
            logical: `marginInlineEnd` follows the writing direction, while a
            hand-picked `-mr-3` lands on the title's side under RTL. */}
        <View className="-me-3">
          <Switch
            value={isSecret}
            accessibilityLabel={t('profiles.secrets.markSecret')}
            onValueChange={setIsSecret}
          />
        </View>
      </View>
      <View className="flex-row gap-2">
        <Button variant="outline" className="flex-1" onPress={onCancel}>
          <Text>{t('common.cancel')}</Text>
        </Button>
        <Button
          className="flex-1"
          loading={isSaving}
          disabled={isSaving}
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
