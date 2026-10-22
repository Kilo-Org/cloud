import * as Haptics from 'expo-haptics';
import { type TFunction } from 'i18next';
import { type ProviderPrPlatform } from '@kilocode/app-shared/provider-review';
import { type RefObject, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/dialog';
import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { type AllowedMergeMethod } from '@/lib/pr-review/merge/merge-blocked-reasons';
import { applyMergeSuccessEffects } from '@/lib/pr-review/merge/merge-success-effects';
import {
  isPrOperationPersistenceFailed,
  PR_OPERATION_PERSISTENCE_FAILED_MESSAGE,
} from '@/lib/pr-review/merge/pr-operation-ledger';
import {
  type EnableAutoMergeVars,
  type MergeVars,
  useEnableAutoMergeMutation,
  useMergePullRequestMutation,
} from '@/lib/pr-review/merge/use-pr-merge-mutations';
import { reconnectExpiredMessage } from '@/lib/pr-review/mutation-error-display';
import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';
import { readTrpcErrorField } from '@/lib/trpc-error';

function staleHeadRejectionMessage(error: unknown): string | null {
  if (readTrpcErrorField(error, 'code') !== 'CONFLICT') {
    return null;
  }
  const message = error instanceof Error ? error.message : '';
  return /changed since it was loaded|closed without merging/.test(message) ? message : null;
}

function mergeForbiddenCopy(platform: ProviderPrPlatform | undefined, t: TFunction): string {
  return platform
    ? t('prReview.merge.providerBlocked.permission', { term: t(providerPrNounKey(platform)) })
    : t('prReview.merge.forbidden');
}

export function usePrMergeSubmit({
  owner,
  repoName,
  number,
  headSha,
  prNodeId,
  mode,
  prRef,
  method,
  noMethodsAllowed,
  showDeleteBranchToggle,
  deleteBranch,
  titleRef,
  messageRef,
  clearMergeDraft,
  onRefetch,
  onDismiss,
}: Readonly<{
  owner: string;
  repoName: string;
  number: number;
  headSha: string;
  prNodeId: string;
  mode: 'merge' | 'enable-auto-merge';
  prRef?: ProviderPrRef;
  method: AllowedMergeMethod;
  noMethodsAllowed: boolean;
  showDeleteBranchToggle: boolean;
  deleteBranch: boolean;
  titleRef: RefObject<string>;
  messageRef: RefObject<string>;
  clearMergeDraft: () => void;
  onRefetch: () => Promise<void>;
  onDismiss: () => void;
}>) {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [inlineErrorKind, setInlineErrorKind] = useState<
    'retryable' | 'non-retryable' | 'reconnect' | null
  >(null);
  const ref = useMemo(() => ({ owner, repo: repoName, number }), [owner, repoName, number]);
  const mergeMutation = useMergePullRequestMutation(prRef ?? ref);
  const enableAutoMergeMutation = useEnableAutoMergeMutation(prRef ?? ref);
  const isMutating =
    (mode === 'merge' && mergeMutation.isPending) ||
    (mode === 'enable-auto-merge' && enableAutoMergeMutation.isPending);
  const lastError = mode === 'merge' ? mergeMutation.error : enableAutoMergeMutation.error;
  const providerPlatform = prRef?.platform;

  useEffect(() => {
    if (lastError) {
      // Persistence failure and a moved head cannot safely retry the same intent.
      if (isPrOperationPersistenceFailed(lastError)) {
        setInlineError(PR_OPERATION_PERSISTENCE_FAILED_MESSAGE);
        setInlineErrorKind('non-retryable');
        return;
      }
      const staleHead = staleHeadRejectionMessage(lastError);
      if (staleHead !== null) {
        setInlineError(staleHead);
        setInlineErrorKind('non-retryable');
        return;
      }
      const classification = classifyPrReviewMutationError(lastError);
      if (classification.kind === 'bad-request' || classification.kind === 'forbidden') {
        setInlineError(
          classification.kind === 'forbidden'
            ? mergeForbiddenCopy(providerPlatform, t)
            : t('prReview.merge.cannotMerge')
        );
        setInlineErrorKind('non-retryable');
      } else if (classification.kind === 'reconnect') {
        setInlineError(reconnectExpiredMessage(providerPlatform));
        setInlineErrorKind('reconnect');
      } else {
        setInlineError(
          lastError instanceof Error ? lastError.message : t('prReview.merge.couldNotMerge')
        );
        setInlineErrorKind('retryable');
      }
    }
  }, [lastError, t, providerPlatform]);

  function buildMergeInput(): MergeVars {
    if (prRef) {
      const commitMessage = messageRef.current.trim();
      return {
        expectedHeadSha: headSha,
        ...(prRef.platform === 'gitlab'
          ? {
              squash: method === 'squash',
              ...(titleRef.current.trim().length > 0
                ? { commitTitle: titleRef.current.trim() }
                : {}),
            }
          : {}),
        deleteBranch: showDeleteBranchToggle ? deleteBranch : false,
        ...(commitMessage.length > 0 ? { commitMessage } : {}),
      };
    }
    return {
      owner,
      repo: repoName,
      number,
      method,
      commitTitle: titleRef.current.trim().length > 0 ? titleRef.current.trim() : undefined,
      commitMessage: messageRef.current.trim().length > 0 ? messageRef.current.trim() : undefined,
      deleteBranch: showDeleteBranchToggle ? deleteBranch : false,
      expectedHeadSha: headSha,
    };
  }

  function buildAutoMergeInput(): EnableAutoMergeVars {
    if (prRef) {
      return { expectedHeadSha: headSha };
    }
    const autoMethod: 'MERGE' | 'SQUASH' | 'REBASE' = (() => {
      if (method === 'merge') {
        return 'MERGE';
      }
      if (method === 'squash') {
        return 'SQUASH';
      }
      return 'REBASE';
    })();
    return {
      prNodeId,
      method: autoMethod,
      commitTitle: titleRef.current.trim().length > 0 ? titleRef.current.trim() : undefined,
      commitMessage: messageRef.current.trim().length > 0 ? messageRef.current.trim() : undefined,
    };
  }

  async function performSubmit() {
    setInlineError(null);
    setInlineErrorKind(null);
    try {
      let celebrate = false;
      // eslint-disable-next-line typescript-eslint/prefer-ternary -- awaits inside branches can't be a ternary expression
      if (mode === 'merge') {
        const result = await mergeMutation.mutateAsync(buildMergeInput());
        ({ celebrate } = applyMergeSuccessEffects(result, ref));
      } else {
        await enableAutoMergeMutation.mutateAsync(buildAutoMergeInput());
        celebrate = true;
      }
      if (celebrate) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await onRefetch();
        clearMergeDraft();
        onDismiss();
      }
    } catch {
      // The mutation error effect renders failures without dismissing the sheet.
    }
  }

  function handleConfirmPress() {
    if (isMutating || noMethodsAllowed) {
      return;
    }
    setInlineError(null);
    setInlineErrorKind(null);
    const submit = () => {
      void performSubmit();
    };
    if (mode === 'merge') {
      const [confirmTitle, confirmMessage] = prRef
        ? [
            t('prReview.merge.confirmTitleTerm', { term: t(providerPrNounKey(prRef.platform)) }),
            t('prReview.merge.confirmMessage'),
          ]
        : [t('prReview.merge.confirmTitle'), t('prReview.merge.confirmMessage')];
      confirm({
        title: confirmTitle,
        message: confirmMessage,
        confirmLabel: t('prReview.merge.merge'),
        onConfirm: submit,
      });
      return;
    }
    confirm({
      title: t('prReview.merge.enableAutoMergeConfirmTitle'),
      message: prRef
        ? t('prReview.merge.enableAutoMergeConfirmMessageTerm', {
            term: t(providerPrNounKey(prRef.platform)),
          })
        : t('prReview.merge.enableAutoMergeConfirmMessage'),
      confirmLabel: t('prReview.merge.enableAutoMerge'),
      onConfirm: submit,
    });
  }

  return { isMutating, inlineError, inlineErrorKind, handleConfirmPress, dialog };
}
