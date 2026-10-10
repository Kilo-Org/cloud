import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { SheetHeader } from '@/components/sheet-header';
import { FormField } from '@/components/ui/form-field';
import { Lock } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { validateProfileDescription, validateProfileName } from '@/lib/agent-profile-forms';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** One manual environment variable as the sheet saves it. */
type SaveProfileVar = Readonly<{ key: string; value: string; isSecret: boolean }>;

export type SaveProfileSubmission = Readonly<{
  name: string;
  description: string;
  setAsDefault: boolean;
}>;

export type SaveProfileSheetProps = Readonly<{
  envVars: readonly SaveProfileVar[];
  setupCommands: readonly string[];
  onClose: () => void;
  /**
   * Persist the profile. The caller owns create/setVar/setCommands/
   * setAsDefault and returns `true` on success (the sheet closes) or `false`
   * on failure (the sheet stays open with the entered values).
   */
  onSave: (submission: SaveProfileSubmission) => Promise<boolean>;
}>;

/**
 * The `Save as Profile` sheet. Mounted only while open, so every open seeds
 * fresh fields. Fields are uncontrolled (refs) per the app's iOS text-input
 * rule; a refused name or an over-long description shows the matching inline
 * error and persists nothing. A failed save keeps the name, description and
 * rows on screen — the sheet never resets on error.
 */
export function SaveProfileSheet({
  envVars,
  setupCommands,
  onClose,
  onSave,
}: Readonly<SaveProfileSheetProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const nameRef = useRef('');
  const descriptionRef = useRef('');
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const hasSecrets = envVars.some(envVar => envVar.isSecret);

  const submit = async () => {
    const name = nameRef.current.trim();
    const description = descriptionRef.current.trim();

    const nameIssue = validateProfileName(name);
    if (nameIssue !== null) {
      setNameError(
        nameIssue === 'empty' ? t('common.required') : t('agentChat.newSession.nameTooLong')
      );
      return;
    }
    if (validateProfileDescription(description) !== null) {
      setDescriptionError(t('agentChat.newSession.descriptionTooLong'));
      return;
    }
    setNameError(null);
    setDescriptionError(null);

    setIsSubmitting(true);
    try {
      const saved = await onSave({ name, description, setAsDefault });
      if (saved) {
        onClose();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SessionPageSheet visible onClose={onClose}>
      <SheetHeader
        title={t('agentChat.newSession.saveAsProfile')}
        onDone={() => {
          void submit();
        }}
        onCancel={onClose}
        doneLabel={t('common.save')}
        disabled={isSubmitting}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <Text variant="muted">{t('agentChat.newSession.saveProfileDescription')}</Text>
        <FormField
          label={t('profiles.nameLabel')}
          defaultValue=""
          placeholder={t('profiles.namePlaceholder')}
          error={nameError ?? undefined}
          disabled={isSubmitting}
          required
          autoCapitalize="sentences"
          autoCorrect={false}
          returnKeyType="next"
          onChangeText={value => {
            nameRef.current = value;
            if (nameError !== null) {
              setNameError(validateProfileName(value.trim()) === null ? null : nameError);
            }
          }}
        />
        <FormField
          label={t('profiles.descriptionLabel')}
          defaultValue=""
          placeholder={t('profiles.descriptionPlaceholder')}
          error={descriptionError ?? undefined}
          disabled={isSubmitting}
          multiline
          textAlignVertical="top"
          className="min-h-20 leading-5"
          autoCapitalize="sentences"
          autoCorrect={false}
          onChangeText={value => {
            descriptionRef.current = value;
            if (descriptionError !== null && validateProfileDescription(value) === null) {
              setDescriptionError(null);
            }
          }}
        />

        <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
          <Text className="flex-1 text-sm font-medium text-foreground">
            {t('profiles.setAsDefault')}
          </Text>
          <Switch
            value={setAsDefault}
            accessibilityLabel={t('profiles.setAsDefault')}
            disabled={isSubmitting}
            onValueChange={setSetAsDefault}
          />
        </View>

        <View className="gap-1 rounded-lg bg-muted p-3">
          <Text className="text-sm font-medium text-foreground">
            {t('agentChat.newSession.profileSummary', {
              vars: envVars.length,
              commands: setupCommands.length,
            })}
          </Text>
          {hasSecrets ? (
            <View className="mt-1 flex-row items-center gap-1.5">
              <Lock size={12} color={colors.mutedForeground} />
              <Text className="text-xs text-muted-foreground">
                {t('agentChat.newSession.secretsEncrypted')}
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
