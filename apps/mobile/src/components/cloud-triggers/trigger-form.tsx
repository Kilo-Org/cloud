/**
 * The trigger form, shared by the create screen and the edit screen.
 *
 * The draft is owned by the screen, so a save can post exactly what the fields
 * show and a refusal can leave the draft untouched. This component owns only
 * which picker sheet is presented, and the band a save failure renders in.
 */

import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { type TriggerDraft, type TriggerDraftProblems } from '@/lib/cloud-triggers/trigger-draft';

import { type TriggerAgentSheet, TriggerFormAgent } from './trigger-form-agent';
import { TriggerFormBasics } from './trigger-form-basics';
import { TriggerFormBehaviour } from './trigger-form-behaviour';

/**
 * A save that failed, with the message the server or the network gave.
 *
 * `retryable` is a failure the same request can plausibly clear (the network,
 * a deadline, a 5xx); `rejected` is the server refusing this input (a taken
 * name, a cron it will not accept, a sandbox rule), where Retry would fail
 * again and the message is what the person acts on.
 */
export type TriggerFormFailure = Readonly<{ kind: 'retryable' | 'rejected'; message: string }>;

type TriggerFormProps = Readonly<{
  mode: 'create' | 'edit';
  organizationId?: string;
  draft: TriggerDraft;
  problems: TriggerDraftProblems;
  onDraftChange: (next: TriggerDraft) => void;
  /** Whether the worker already holds a secret for this trigger. */
  authConfigured: boolean;
  /** Bumped by a screen after a save, so the secret field remounts empty. */
  secretResetKey?: number;
  submitting: boolean;
  submitLabel: string;
  canSubmit: boolean;
  onSubmit: () => void;
  failure: TriggerFormFailure | null;
  onRetry: () => void;
  onDismissFailure: () => void;
  /** The screen's own trailing controls: Save and invoke, Delete. */
  footer?: ReactNode;
}>;

function FailureBand({
  failure,
  onRetry,
  onDismiss,
}: Readonly<{ failure: TriggerFormFailure; onRetry: () => void; onDismiss: () => void }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-2 rounded-lg border border-destructive p-3">
      <Text className="text-sm font-medium text-destructive">
        {t('cloudAgent.triggers.saveFailedTitle')}
      </Text>
      <Text variant="muted" className="text-xs">
        {failure.message}
      </Text>
      <View className="flex-row gap-2">
        {failure.kind === 'retryable' ? (
          <Button variant="outline" onPress={onRetry}>
            <Text>{t('common.retry')}</Text>
          </Button>
        ) : null}
        <Button variant="ghost" onPress={onDismiss}>
          <Text>{t('common.close')}</Text>
        </Button>
      </View>
    </View>
  );
}

export function TriggerForm({
  mode,
  organizationId,
  draft,
  problems,
  onDraftChange,
  authConfigured,
  secretResetKey = 0,
  submitting,
  submitLabel,
  canSubmit,
  onSubmit,
  failure,
  onRetry,
  onDismissFailure,
  footer,
}: TriggerFormProps) {
  const [repositoryPickerOpen, setRepositoryPickerOpen] = useState(false);
  const [agentSheet, setAgentSheet] = useState<TriggerAgentSheet>(null);
  return (
    // One 16dp row gap for every field break, inside the sections and between
    // them; the hairlines' -my-2 keeps their 0.5dp line from doubling the
    // section break to 48.5dp.
    <View className="gap-4">
      <TriggerFormBasics
        mode={mode}
        organizationId={organizationId}
        draft={draft}
        problems={problems}
        onDraftChange={onDraftChange}
        repositoryPickerOpen={repositoryPickerOpen}
        onRepositoryPickerOpenChange={setRepositoryPickerOpen}
      />
      <View className="-my-2 h-[0.5px] bg-hair-soft" />
      <TriggerFormAgent
        organizationId={organizationId}
        draft={draft}
        problems={problems}
        onDraftChange={onDraftChange}
        openSheet={agentSheet}
        onOpenSheetChange={setAgentSheet}
      />
      <View className="-my-2 h-[0.5px] bg-hair-soft" />
      <TriggerFormBehaviour
        mode={mode}
        organizationId={organizationId}
        draft={draft}
        problems={problems}
        authConfigured={authConfigured}
        secretResetKey={secretResetKey}
        onDraftChange={onDraftChange}
      />
      {failure === null ? null : (
        <FailureBand failure={failure} onRetry={onRetry} onDismiss={onDismissFailure} />
      )}
      <View className="gap-2">
        <Button
          className={STATE_ACTION_CLASS}
          onPress={onSubmit}
          disabled={!canSubmit || submitting}
          loading={submitting}
        >
          <Text>{submitLabel}</Text>
        </Button>
        {footer}
      </View>
    </View>
  );
}
