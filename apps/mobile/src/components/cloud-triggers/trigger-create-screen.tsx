/**
 * Creating a trigger, in the caller's own scope or an organization's.
 *
 * The draft starts on the device's time zone and the webhook activation, and it
 * is the screen — not the form — that posts it: a refusal keeps every field as
 * typed, and the failure band names what to fix. A created trigger opens its own
 * screen, where the URL an inbound call needs is on show.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  buildCreateInput,
  hasTriggerDraftProblems,
  newTriggerDraft,
  triggerDraftProblems,
  type TriggerDraft,
} from '@/lib/cloud-triggers/trigger-draft';
import { triggerProblemMessage } from '@/lib/cloud-triggers/trigger-problem-copy';
import { triggerDetailHref } from '@/lib/cloud-triggers/trigger-routes';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { isRetryableTrpcError, readTrpcErrorField } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';

import { TriggerForm, type TriggerFormFailure } from './trigger-form';

type TriggerCreateScreenProps = Readonly<{
  organizationId?: string;
}>;

export function TriggerCreateScreen({ organizationId }: TriggerCreateScreenProps) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<TriggerDraft>(() =>
    newTriggerDraft(Intl.DateTimeFormat().resolvedOptions().timeZone)
  );
  const { feedback, failure, begin, clearWhere } = useSurfaceFeedback<TriggerFormFailure>();
  const create = useMutation(trpc.webhookTriggers.create.mutationOptions());
  const problems = triggerDraftProblems(draft, { mode: 'create', authConfigured: false });
  const submitting = feedback.status === 'pending';

  const submit = async () => {
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
      router.replace(triggerDetailHref(created.triggerId, organizationId) as Href);
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
            setDraft(next);
          }}
          authConfigured={false}
          submitting={submitting}
          submitLabel={t('cloudAgent.triggers.new')}
          canSubmit={!hasTriggerDraftProblems(problems) && !submitting}
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
    </View>
  );
}
