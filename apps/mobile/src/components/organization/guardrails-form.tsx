import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { issueMessage } from '@/components/organization/guardrails-copy';
import { InputGuardrailsSection } from '@/components/organization/guardrails-input-section';
import { OutputGuardrailsSection } from '@/components/organization/guardrails-output-section';
import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useSaveOrgGuardrails } from '@/lib/hooks/use-org-settings-queries';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { configKey, draftsEqual } from '@/lib/organization/guardrails-config-key';
import {
  buildUpdateInput,
  type GuardrailsDraft,
  isGuardrailsFormDraft,
  type OrgGuardrails,
  type OrgGuardrailsConfig,
  toDraft,
} from '@/lib/organization/guardrails-draft';
import { guardrailsIssues } from '@/lib/organization/guardrails-issues';
import { type SettingsSaveFailure, settingsSaveStatus } from '@/lib/organization/settings-save';
import { orgGuardrailsFormDraftKey } from '@/lib/persist/drafts';
import { useFormDraft } from '@/lib/persist/use-form-draft';
import { knownServerErrorMessage } from '@/lib/server-error-copy';

/**
 * The guardrails form: the dirty draft, its save, and the keep-editing gate.
 *
 * The web page autosaves; the phone saves on request, so a flaky connection
 * cannot half-apply a configuration. The keep-editing gate reads a ref the
 * removal handler cannot recompute, so every draft change reports the next
 * dirty state to it, the same shape mode-form's `syncDirty` uses for its
 * event-driven form; Back while the draft holds edits asks Keep editing /
 * Discard, and a settled save (or Cancel) disarms it.
 *
 * The draft also lives in the account-scoped encrypted store: a device language
 * change that flips the text direction reloads the bundle, which kills this tree
 * without running its cleanup, and the typed configuration would come back
 * empty. The form has the server's configuration to show, so it renders from
 * that at once and applies a restored draft once, only while the person has
 * typed nothing.
 */
export function GuardrailsForm({
  organizationId,
  canManageBilling = false,
  data,
}: Readonly<{
  organizationId: string;
  /** Whether the reader may change the plan; it picks the refusal's sentence. */
  canManageBilling?: boolean;
  data: OrgGuardrails;
}>) {
  const { t } = useTranslation();
  // The screen resolves the reader's role once and hands it down: this form
  // renders no billing step beside the failure line, so a money role reads the
  // sentence that names the destination instead of one that claims an owner
  // must act.
  const save = useSaveOrgGuardrails(organizationId, canManageBilling);
  const { feedback, begin, clearWhere } = useSurfaceFeedback<SettingsSaveFailure>();
  const outputAvailable = data.output_available;
  const { groups } = data;
  const config: OrgGuardrailsConfig = {
    enabled: data.enabled,
    group_id: data.group_id,
    detectors: data.detectors,
    output: data.output,
  };
  const serverKey = configKey(config, outputAvailable);
  const [syncedKey, setSyncedKey] = useState(serverKey);
  const [baseline, setBaseline] = useState(() => toDraft(config));
  const [draft, setDraft] = useState(() => toDraft(config));
  // Both sections' text fields are uncontrolled: they read their `defaultValue`
  // on mount, so replacing the whole draft (a rebase, a save's answer, Cancel)
  // remounts them rather than leaving text the draft no longer holds.
  const [draftGeneration, setDraftGeneration] = useState(0);
  const replaceDraft = useCallback((next: GuardrailsDraft) => {
    setDraft(next);
    setDraftGeneration(generation => generation + 1);
  }, []);

  const { userId, isLoading: isIdentityLoading } = useCurrentUserId();
  const formDraft = useFormDraft<GuardrailsDraft>({
    userId,
    isIdentityLoading,
    entityKey: orgGuardrailsFormDraftKey(organizationId),
    validate: isGuardrailsFormDraft,
  });
  // An edit owns the form: a stored draft that lands later never replaces typed
  // fields, and a restore runs once per mount.
  const touchedRef = useRef(false);
  const restoredRef = useRef(false);
  const restoredDraft = formDraft.kind === 'ready' ? formDraft.value : null;

  // A save already in flight owns the route: a Back press is dropped instead of
  // offered a Discard, because the write lands even if the screen popped first.
  const saving = feedback.status === 'pending';

  // Declared before the rebase block below, which reports on every render that
  // takes it.
  const guard = useMetadataLeaveGuard({
    enabled: true,
    saving,
    // A confirmed Discard is the person dropping the draft on purpose, whether
    // or not the store has answered: `clear` writes through while loading.
    onDiscard: formDraft.clear,
  });

  useEffect(() => {
    if (restoredDraft === null || touchedRef.current || restoredRef.current) {
      return;
    }
    restoredRef.current = true;
    replaceDraft(restoredDraft);
    guard.handleDirtyChange(!draftsEqual(restoredDraft, baseline, outputAvailable));
  }, [restoredDraft, replaceDraft, guard, baseline, outputAvailable]);

  // A refetch that moved the server's configuration rebases the form, unless
  // the form holds edits of its own: those win, and the next save replaces the
  // newer settings. The guard follows the post-rebase state: a rebased clean
  // draft becomes `next`, so it reports clean and Back never asks; a draft
  // that keeps its edits reports dirty against the new configuration.
  if (serverKey !== syncedKey) {
    setSyncedKey(serverKey);
    const next = toDraft(config);
    const clean = draftsEqual(draft, baseline, outputAvailable);
    setBaseline(next);
    if (clean) {
      replaceDraft(next);
    }
    guard.handleDirtyChange(!clean && !draftsEqual(draft, next, outputAvailable));
  }

  const issues = guardrailsIssues(draft, outputAvailable);
  const dirty = !draftsEqual(draft, baseline, outputAvailable);
  const firstIssue = issues[0];
  const editDraft = (update: (current: GuardrailsDraft) => GuardrailsDraft) => {
    clearWhere(() => true);
    const next = update(draft);
    touchedRef.current = true;
    setDraft(next);
    // The whole draft, on every edit: a reload may follow any of them, and the
    // hook writes through while it still reports `loading`.
    formDraft.save(next);
    guard.handleDirtyChange(!draftsEqual(next, baseline, outputAvailable));
  };

  const onSave = async () => {
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    try {
      const result = await save.mutateAsync({
        organizationId,
        ...buildUpdateInput(draft, outputAvailable),
      });
      if (!attempt.owns()) {
        return;
      }
      const saved: OrgGuardrailsConfig = {
        enabled: result.enabled,
        group_id: result.group_id,
        detectors: result.detectors,
        output: result.output,
      };
      setSyncedKey(configKey(saved, outputAvailable));
      const savedDraft = toDraft(saved);
      setBaseline(savedDraft);
      replaceDraft(savedDraft);
      // The draft became the saved record; nothing is left to restore.
      restoredRef.current = true;
      formDraft.clear();
      guard.handleDirtyChange(false);
      attempt.succeed();
    } catch (error) {
      attempt.fail({
        kind: 'save-failed',
        message:
          knownServerErrorMessage(error, canManageBilling, 'absent') ??
          t('organizationGuardrails.statusFailed'),
      });
    }
  };

  const statusMessage = settingsSaveStatus({
    t,
    feedback,
    draftIsDirty: dirty,
    blockingIssue: firstIssue === undefined ? null : issueMessage(t, firstIssue),
  });

  return (
    <View className="gap-6">
      {data.invalid_saved_detectors ? (
        <Card className="gap-1 border border-destructive">
          <Text className="text-sm font-medium text-foreground">
            {t('organizationGuardrails.invalidSavedTitle')}
          </Text>
          <Text variant="caption">{t('organizationGuardrails.invalidSavedBody')}</Text>
        </Card>
      ) : null}
      {outputAvailable && data.invalid_saved_output_detectors ? (
        <Card className="gap-1 border border-destructive">
          <Text className="text-sm font-medium text-foreground">
            {t('organizationGuardrails.invalidSavedOutputTitle')}
          </Text>
          <Text variant="caption">{t('organizationGuardrails.invalidSavedOutputBody')}</Text>
        </Card>
      ) : null}

      <InputGuardrailsSection
        key={`input-${draftGeneration}`}
        draft={draft}
        groups={groups}
        disabled={saving}
        onChange={editDraft}
      />

      {outputAvailable ? (
        <OutputGuardrailsSection
          key={`output-${draftGeneration}`}
          draft={draft}
          disabled={saving}
          onChange={editDraft}
        />
      ) : null}

      <View className="gap-2">
        {/* The slot keeps its height whether or not a message shows, so the
            buttons below never move when a save settles. */}
        <View className="min-h-5 justify-center">
          <AccessibleStatus
            message={statusMessage}
            tone={feedback.status === 'failed' ? 'error' : 'status'}
            className="text-sm"
          />
        </View>
        <View className="flex-row gap-3">
          <Button
            variant="outline"
            className="flex-1"
            disabled={!dirty || saving}
            onPress={() => {
              clearWhere(() => true);
              // Cancel drops the draft on purpose, so the stored copy goes too.
              touchedRef.current = true;
              formDraft.clear();
              replaceDraft(baseline);
              guard.handleDirtyChange(false);
            }}
          >
            <Text>{t('common.cancel')}</Text>
          </Button>
          <Button
            className="flex-1"
            loading={saving}
            disabled={!dirty || saving || issues.length > 0}
            onPress={() => void onSave()}
          >
            <Text>{t('common.save')}</Text>
          </Button>
        </View>
      </View>
      {guard.dialog}
    </View>
  );
}
