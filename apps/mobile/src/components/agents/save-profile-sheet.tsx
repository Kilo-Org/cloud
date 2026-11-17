import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import {
  ProfileDescriptionField,
  ProfileNameField,
} from '@/components/profiles/profile-bound-field';
import { SheetHeader } from '@/components/sheet-header';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Card } from '@/components/ui/card';
import { Lock } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { validateProfileDescription } from '@/lib/agent-profile-forms';
import { useProfileNameField } from '@/lib/hooks/use-profile-name-field';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { draftProfileCountItems, formatProfileCountItems } from '@/lib/profile-count-labels';
import { cn } from '@/lib/utils';

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

/** The save's own refusal; the sheet's one line is the copy, so no message travels. */
type SaveProfileFailure = { readonly kind: 'save-failed' };

/** The sheet's one line for this failure; it has a single refusal arm. */
function saveFailureMessage(t: (key: string) => string): string {
  return t('profiles.saveFailed');
}

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
  const nameField = useProfileNameField();
  const descriptionRef = useRef('');
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const save = useSurfaceFeedback<SaveProfileFailure>();
  const feedback = save.feedback;
  const isSaving = feedback.status === 'pending';

  const hasSecrets = envVars.some(envVar => envVar.isSecret);
  // Both numbers are counted messages, so the line agrees with each one instead
  // of naming a fixed plural; it shares the wording of every profile surface.
  const summary = formatProfileCountItems(
    t,
    draftProfileCountItems(envVars.length, setupCommands.length)
  ).join(' · ');

  const { requestClose, requestDismiss, dialog } = useSheetDismissGuard({
    isDirty: () =>
      nameField.valueRef.current.trim().length > 0 ||
      descriptionRef.current.trim().length > 0 ||
      setAsDefault,
    isRunning: () => isSaving,
    onDiscard: onClose,
  });

  const submit = async () => {
    const name = nameField.commit();
    if (name === null) {
      return;
    }
    const description = descriptionRef.current.trim();

    if (validateProfileDescription(description) !== null) {
      setDescriptionError(t('agentChat.newSession.descriptionTooLong'));
      return;
    }
    setDescriptionError(null);

    const attempt = save.begin();
    if (attempt === null) {
      return;
    }
    try {
      const saved = await onSave({ name, description, setAsDefault });
      // The sheet closing is its own new state, so a success publishes no phase.
      // It is still fenced: a token from a closed sheet is dead, and the panel's
      // instance id stops this closure from closing its successor.
      if (saved) {
        if (attempt.abandon()) {
          onClose();
        }
        return;
      }
      attempt.fail({ kind: 'save-failed' });
    } catch {
      attempt.fail({ kind: 'save-failed' });
    }
  };

  return (
    <SessionPageSheet visible onClose={onClose} onRequestDismiss={requestDismiss}>
      <SheetHeader
        title={t('agentChat.newSession.saveAsProfile')}
        onDone={() => {
          void submit();
        }}
        onCancel={requestClose}
        doneLabel={t('common.save')}
        doneDisabled={isSaving}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-8')}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <Text variant="muted">{t('agentChat.newSession.saveProfileDescription')}</Text>
        {/* The refusal overlays the copy this slot already lays out, so a
            rejected save never inserts space and the fields cannot move. */}
        <View testID="save-profile-status">
          <View
            className="opacity-0"
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID="save-profile-status-reserve"
          >
            <Text className="text-sm">{saveFailureMessage(t)}</Text>
          </View>
          {save.failure !== null ? (
            <View className="absolute inset-0 justify-center" testID="save-profile-status-live">
              <AccessibleStatus className="text-sm" message={saveFailureMessage(t)} />
            </View>
          ) : null}
        </View>
        <ProfileNameField
          defaultValue=""
          error={nameField.error}
          disabled={isSaving}
          autoCorrect={false}
          onChangeText={nameField.handleChangeText}
        />
        <ProfileDescriptionField
          defaultValue=""
          error={descriptionError ?? undefined}
          disabled={isSaving}
          autoCorrect={false}
          onChangeText={value => {
            descriptionRef.current = value;
            if (descriptionError !== null && validateProfileDescription(value) === null) {
              setDescriptionError(null);
            }
          }}
        />

        <RowGroup>
          <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3')}>
            <Text className="flex-1 text-sm font-medium text-foreground">
              {t('profiles.setAsDefault')}
            </Text>
            <Switch
              value={setAsDefault}
              accessibilityLabel={t('profiles.setAsDefault')}
              disabled={isSaving}
              onValueChange={setSetAsDefault}
            />
          </View>
        </RowGroup>

        {summary.length > 0 || hasSecrets ? (
          <Card>
            {summary.length > 0 ? (
              <Text className="text-sm font-medium text-foreground">{summary}</Text>
            ) : null}
            {hasSecrets ? (
              <View className="flex-row items-center gap-1.5">
                <Lock size={12} color={colors.mutedForeground} />
                <Text variant="caption">{t('agentChat.newSession.secretsEncrypted')}</Text>
              </View>
            ) : null}
          </Card>
        ) : null}
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
      {dialog}
    </SessionPageSheet>
  );
}
