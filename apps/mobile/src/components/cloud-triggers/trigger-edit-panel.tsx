/**
 * The edit half of a trigger's screen: its saved configuration, the form that
 * changes it, the writes, and the deliveries it has taken.
 *
 * The draft is this panel's own state, seeded from the configuration the worker
 * answered with. A save posts the draft and, when it lands, clears the secret
 * field (the server now holds it) without touching anything else typed.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Play, Trash2 } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  buildUpdateInput,
  type CloudTriggerDetail,
  hasTriggerDraftProblems,
  type TriggerDraft,
  triggerDraftFromDetail,
  triggerDraftProblems,
} from '@/lib/cloud-triggers/trigger-draft';
import { triggerProblemMessage } from '@/lib/cloud-triggers/trigger-problem-copy';
import { triggersListHref } from '@/lib/cloud-triggers/trigger-routes';
import { useTriggerMutations } from '@/lib/cloud-triggers/use-cloud-triggers';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { isRetryableTrpcError, readTrpcErrorField } from '@/lib/trpc-error';
import { useTRPC } from '@/lib/trpc';
import { useStackSafeReplace } from '@/lib/navigation/stack-safe-replace';

import { TriggerDeliveries } from './trigger-deliveries';
import { TriggerForm, type TriggerFormFailure } from './trigger-form';
import { TriggerUrlCard } from './trigger-url-card';

export function TriggerEditPanel({
  detail,
  organizationId,
}: Readonly<{ detail: CloudTriggerDetail; organizationId?: string }>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  // The post-delete hand-off swaps the detail screen for the list screen in one
  // commit; a literal `router.replace` crashes Android Fabric there (the
  // session-route crash class, KILO-APP-25), so it goes through the
  // push-then-retire hook instead.
  const router = useStackSafeReplace();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const { confirm, dialog } = useConfirmDialog();
  const [draft, setDraft] = useState<TriggerDraft>(() => triggerDraftFromDetail(detail));
  // Bumped after a save so the uncontrolled secret field remounts empty.
  const [secretResetKey, setSecretResetKey] = useState(0);
  const { feedback, failure, begin, clearWhere } = useSurfaceFeedback<TriggerFormFailure>();
  const save = useMutation(
    trpc.webhookTriggers.update.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.webhookTriggers.list.pathFilter());
      },
    })
  );
  const { remove, invoke } = useTriggerMutations(detail.triggerId, organizationId);
  const scope = organizationId === undefined ? {} : { organizationId };
  const authConfigured = detail.webhookAuthConfigured;
  const problems = triggerDraftProblems(draft, { mode: 'edit', authConfigured });
  const submitting = feedback.status === 'pending';
  const isScheduled = detail.activationMode === 'scheduled';

  const saveDraft = async (): Promise<boolean> => {
    const attempt = begin();
    if (attempt === null) {
      return false;
    }
    const input = buildUpdateInput(draft, {
      triggerId: detail.triggerId,
      organizationId,
      authConfigured,
    });
    if (input === null) {
      attempt.fail({ kind: 'rejected', message: triggerProblemMessage('bodySchemaInvalid') });
      return false;
    }
    try {
      await save.mutateAsync(input);
      const detailKey = trpc.webhookTriggers.get.queryKey({
        triggerId: detail.triggerId,
        ...scope,
      });
      void queryClient.invalidateQueries({ queryKey: detailKey });
      // The stored secret is the worker's now; the field stays empty.
      setDraft(current => ({ ...current, authSecret: '' }));
      setSecretResetKey(key => key + 1);
      if (!attempt.succeed()) {
        return false;
      }
      announcingToast.success(t('cloudAgent.triggers.saved'));
      return true;
    } catch (error) {
      const message = readTrpcErrorField(error, 'message') ?? t('common.somethingWentWrong');
      attempt.fail({ kind: isRetryableTrpcError(error) ? 'retryable' : 'rejected', message });
      return false;
    }
  };

  const invokeNow = () => {
    invoke.mutate({ triggerId: detail.triggerId, ...scope });
  };

  return (
    <View className="gap-6">
      {isScheduled ? null : <TriggerUrlCard url={detail.inboundUrl} />}
      <TriggerForm
        mode="edit"
        organizationId={organizationId}
        draft={draft}
        problems={problems}
        onDraftChange={next => {
          clearWhere(candidate => candidate.kind === 'rejected');
          setDraft(next);
        }}
        authConfigured={authConfigured}
        secretResetKey={secretResetKey}
        submitting={submitting}
        submitLabel={t('common.save')}
        canSubmit={!hasTriggerDraftProblems(problems) && !submitting}
        onSubmit={() => {
          void saveDraft();
        }}
        failure={failure}
        onRetry={() => {
          void saveDraft();
        }}
        onDismissFailure={() => {
          clearWhere(() => true);
        }}
        footer={
          <View className="gap-2">
            {isScheduled && detail.canRun ? (
              <Button
                variant="outline"
                onPress={invokeNow}
                disabled={invoke.isPending || !detail.isActive}
              >
                <Play size={16} color={colors.foreground} />
                <Text>{t('cloudAgent.triggers.runNow')}</Text>
              </Button>
            ) : null}
            <Button
              variant="outline-destructive"
              disabled={remove.isPending}
              onPress={() => {
                confirm({
                  title: t('cloudAgent.triggers.deleteTitle'),
                  message: t(
                    isScheduled
                      ? 'cloudAgent.triggers.deleteMessageScheduled'
                      : 'cloudAgent.triggers.deleteMessage',
                    { name: detail.triggerId }
                  ),
                  confirmLabel: t('common.delete'),
                  onConfirm: () => {
                    remove.mutate(
                      { triggerId: detail.triggerId, ...scope },
                      {
                        onSuccess: () => {
                          router.replace(triggersListHref(organizationId));
                        },
                      }
                    );
                  },
                });
              }}
            >
              <Trash2 size={16} color={colors.destructive} />
              <Text>{t('common.delete')}</Text>
            </Button>
          </View>
        }
      />
      <View className="gap-2">
        <Text className="text-sm font-medium text-foreground">
          {t('cloudAgent.triggers.deliveries')}
        </Text>
        <TriggerDeliveries triggerId={detail.triggerId} organizationId={organizationId} />
      </View>
      {dialog}
    </View>
  );
}
