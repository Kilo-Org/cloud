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
import { renderRowTrailing } from '@/components/ui/row-trailing';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { agentProfileMutationErrorMessage } from '@/lib/agent-profile-error-copy';
import { validateProfileDescription } from '@/lib/agent-profile-forms';
import { useProfileNameField } from '@/lib/hooks/use-profile-name-field';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { draftProfileCountItems, formatProfileCountItems } from '@/lib/profile-count-labels';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';
import { cn } from '@/lib/utils';

/** One manual environment variable as the sheet saves it. */
type SaveProfileVar = Readonly<{ key: string; value: string; isSecret: boolean }>;

export type SaveProfileSubmission = Readonly<{
  name: string;
  description: string;
  setAsDefault: boolean;
}>;

/**
 * A save either completed, or was refused with the server's own sentence, or
 * failed with an unknown outcome.
 */
export type SaveProfileOutcome =
  | Readonly<{ saved: true }>
  | Readonly<{ saved: false; refusal: string | null }>;

export type SaveProfileSheetProps = Readonly<{
  envVars: readonly SaveProfileVar[];
  setupCommands: readonly string[];
  onClose: () => void;
  /**
   * Persist the profile. The caller owns the write, which now carries the
   * vars, the setup commands and the default flag in the one create, so a
   * refusal stores nothing. Resolves `{ saved: true }` on success (the sheet
   * closes), or `{ saved: false, refusal }` on failure (the sheet stays open
   * with the entered values), where `refusal` is the server's own sentence and
   * `null` means no answer arrived.
   */
  onSave: (submission: SaveProfileSubmission) => Promise<SaveProfileOutcome>;
}>;

/** The save's own refusal. `refused` carries the server's sentence; `unknown` had no answer. */
type SaveProfileFailure =
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'unknown' };

/**
 * The sheet's one line for a failure: a recognized refusal, translated by the
 * shared helper, every other server sentence unchanged, or the neutral retry
 * line when no answer arrived.
 */
function saveFailureMessage(t: (key: string) => string, failure: SaveProfileFailure): string {
  switch (failure.kind) {
    case 'refused': {
      return agentProfileMutationErrorMessage(failure.message);
    }
    case 'unknown': {
      return t('profiles.saveFailed');
    }
    default: {
      return assertSurfaceFailureHandled(failure);
    }
  }
}

/**
 * The `Save as profile` sheet. Mounted only while open, so every open seeds
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
      const outcome = await onSave({ name, description, setAsDefault });
      // The sheet closing is its own new state, so a success publishes no phase.
      // It is still fenced: a token from a closed sheet is dead, and the panel's
      // instance id stops this closure from closing its successor.
      if (outcome.saved) {
        if (attempt.abandon()) {
          onClose();
        }
        return;
      }
      attempt.fail(
        outcome.refusal === null
          ? { kind: 'unknown' }
          : { kind: 'refused', message: outcome.refusal }
      );
    } catch {
      attempt.fail({ kind: 'unknown' });
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
            {renderRowTrailing({
              kind: 'switch',
              value: setAsDefault,
              accessibilityLabel: t('profiles.setAsDefault'),
              disabled: isSaving,
              onValueChange: setSetAsDefault,
            })}
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
        {/* The refusal closes the form: it is the last block of the body, so a
            rejected save adds its line under everything else and no field
            moves, and the intro text sits on the first field with no space
            held for a line that is usually absent. A null message renders
            nothing. */}
        <AccessibleStatus
          className="text-sm"
          message={save.failure === null ? null : saveFailureMessage(t, save.failure)}
        />
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
      {dialog}
    </SessionPageSheet>
  );
}
