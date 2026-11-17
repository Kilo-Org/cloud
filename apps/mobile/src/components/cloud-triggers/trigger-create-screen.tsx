/**
 * Creating a trigger, in the caller's own scope or an organization's.
 *
 * The draft starts on the device's time zone and the webhook activation, and it
 * is the screen — not the form — that posts it: a refusal keeps every field as
 * typed, and the failure band names what to fix. A created trigger opens its own
 * screen, where the URL an inbound call needs is on show.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useMetadataLeaveGuard } from '@/components/profiles/use-metadata-leave-guard';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  buildCreateInput,
  createTriggerDraft,
  hasTriggerDraftProblems,
  type TriggerDraft,
  triggerDraftProblems,
} from '@/lib/cloud-triggers/trigger-draft';
import { triggerProblemMessage } from '@/lib/cloud-triggers/trigger-problem-copy';
import { triggerDetailHref } from '@/lib/cloud-triggers/trigger-routes';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';
import { deviceTimeZone } from '@/lib/intl-cache';
import { isRetryableTrpcError, readTrpcErrorField } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';

import { TriggerForm, type TriggerFormFailure } from './trigger-form';

type TriggerCreateScreenProps = Readonly<{
  organizationId?: string;
}>;

/** Whether a draft differs from the one the screen started on. */
function isDraftDirty(draft: TriggerDraft, initialDraft: TriggerDraft): boolean {
  for (const key of Object.keys(initialDraft) as (keyof TriggerDraft)[]) {
    if (draft[key] !== initialDraft[key]) {
      return true;
    }
  }
  return false;
}

export function TriggerCreateScreen({ organizationId }: TriggerCreateScreenProps) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  // The post-create hand-off swaps the create screen for the detail screen in
  // one commit; a literal `router.replace` crashes Android Fabric there (the
  // session-route crash class, KILO-APP-25), so it goes through the
  // push-then-retire hook instead.
  const router = useStackSafeReplace();
  const queryClient = useQueryClient();
  // The draft this screen started on, captured once: every field including the
  // time zone can be edited back to a different value, so the dirty test
  // compares against what the reader began with, not against a fresh draft
  // rebuilt around the current value. After a create succeeds, the baseline
  // moves to the draft the trigger was saved from: the hand-off can drop its
  // retire (a Back that lands before the push settles keeps this screen
  // mounted), and a surviving screen must then read its saved values as saved
  // — resetting the state would leave the form's `defaultValue` fields
  // painting the created trigger's text over a blank draft.
  const [initialDraft, setInitialDraft] = useState<TriggerDraft>(() =>
    createTriggerDraft(deviceTimeZone())
  );
  const [draft, setDraft] = useState<TriggerDraft>(() => initialDraft);
  // A create that succeeded owns this screen's submit: the hand-off should
  // retire the form, but the navigator can refuse that retire and leave this
  // screen focused with the created trigger's values on it. Submitting again
  // would post the trigger a second time, so the form stays submitted for the
  // life of the draft, and a field edit that sets a new draft starts a new one.
  const [submittedDraft, setSubmittedDraft] = useState<TriggerDraft | null>(null);
  const { feedback, failure, begin, clearWhere } = useSurfaceFeedback<TriggerFormFailure>();
  const create = useMutation(trpc.webhookTriggers.create.mutationOptions());
  const problems = triggerDraftProblems(draft, { mode: 'create', authConfigured: false });
  const submitting = feedback.status === 'pending';
  // A create that succeeded owns this screen's save until an edit starts a new
  // draft: the form the hand-off leaves mounted must not post a second copy.
  const submitted = draft === submittedDraft;
  const guard = useMetadataLeaveGuard({
    enabled: true,
    isDirty: () => isDraftDirty(draft, initialDraft),
  });

  const submit = async () => {
    if (submitted) {
      return;
    }
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    const input = buildCreateInput(draft, organizationId);
    if (input === null) {
      attempt.fail({ kind: 'rejected', message: triggerProblemMessage('bodySchemaInvalid') });
      return;
    }
    try {
      const created = await create.mutateAsync(input);
      void queryClient.invalidateQueries(trpc.webhookTriggers.list.pathFilter());
      if (!attempt.succeed()) {
        return;
      }
      announcingToast.success(t('cloudAgent.triggers.created'));
      // The saved values are the new baseline: a screen the hand-off leaves
      // mounted reads its own saved draft as clean, and a later edit asks.
      setInitialDraft(draft);
      // A screen the hand-off leaves mounted must not post a second trigger:
      // one create is the screen's only save. A field edit that replaces the
      // draft starts a new one and re-enables the submit.
      setSubmittedDraft(draft);
      // Landing on the detail replaces this create screen: Back must not return
      // to a form for a trigger that now exists. Leaving through the guard
      // disarms it first, so the retire `navigation.reset` that the push-then-
      // retire hook runs after the push is never intercepted as a Back on a
      // draft that was just saved. The detail route's stack repair then puts
      // the triggers list beneath it, so Back returns to the list on every
      // entry path.
      guard.leaveWithoutAsking(() => {
        router.replace(triggerDetailHref(created.triggerId, organizationId));
      });
    } catch (error) {
      const message = readTrpcErrorField(error, 'message') ?? t('common.somethingWentWrong');
      attempt.fail({ kind: isRetryableTrpcError(error) ? 'retryable' : 'rejected', message });
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('cloudAgent.triggers.new')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-4 pt-4"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <TriggerForm
          mode="create"
          organizationId={organizationId}
          draft={draft}
          problems={problems}
          onDraftChange={next => {
            clearWhere(candidate => candidate.kind === 'rejected');
            setSubmittedDraft(null);
            setDraft(next);
          }}
          authConfigured={false}
          submitting={submitting}
          submitLabel={t('cloudAgent.triggers.new')}
          canSubmit={!hasTriggerDraftProblems(problems) && !submitting && !submitted}
          onSubmit={() => {
            void submit();
          }}
          failure={failure}
          onRetry={() => {
            void submit();
          }}
          onDismissFailure={() => {
            clearWhere(() => true);
          }}
        />
      </TabScreenScrollView>
      {guard.dialog}
    </View>
  );
}
