import { useMutation, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import { type ProposalDraft } from '@/lib/review-memory-proposals';
import { trpcClient, useTRPC } from '@/lib/trpc';

// Review memory only exists for GitHub, so the owner input pins the platform
// and only varies the scope segment (personal vs. an organization id).
export function reviewMemoryOwnerInput(scope: string) {
  return scope === PERSONAL_SCOPE
    ? { platform: 'github' as const }
    : { organizationId: scope, platform: 'github' as const };
}

export function useSetReviewMemoryEnabled(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ownerInput = reviewMemoryOwnerInput(scope);

  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (enabled: boolean) =>
      trpcClient.reviewMemory.setEnabled.mutate({ ...ownerInput, enabled }),
    onSuccess: data => {
      // The stored value is authoritative, so write it into the cached summary
      // as soon as the mutation settles: the switch and the screen's state
      // branch read one source, and the refetch below replaces it with the
      // server's answer instead of a value that outlives the request.
      queryClient.setQueryData(
        trpc.reviewMemory.getDashboardSummary.queryKey(ownerInput),
        previous => (previous ? { ...previous, enabled: data.enabled } : previous)
      );
      void queryClient.invalidateQueries({
        queryKey: trpc.reviewMemory.getDashboardSummary.queryKey(ownerInput),
      });
    },
    onError: error => {
      announcingToast.error(error.message);
    },
  });
}

export function useReviewMemoryProposalActions(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ownerInput = reviewMemoryOwnerInput(scope);
  const onError = (error: { message: string }) => {
    announcingToast.error(error.message);
  };
  const onSettled = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: trpc.reviewMemory.getDashboardSummary.queryKey(ownerInput),
      }),
      queryClient.invalidateQueries({
        queryKey: trpc.reviewMemory.listProposalsPage.pathKey(),
      }),
    ]);
  };
  const save = useMutation(
    trpc.reviewMemory.updateProposal.mutationOptions({
      onError,
      onSettled,
      onSuccess: () => {
        announcingToast.success(i18n.t('codeReviewer.reviewMemory.proposalSaved'));
      },
    })
  );
  const reject = useMutation(
    trpc.reviewMemory.rejectProposal.mutationOptions({
      onError,
      onSettled,
      onSuccess: () => {
        announcingToast.success(i18n.t('codeReviewer.reviewMemory.proposalDismissed'));
      },
    })
  );
  const approve = useMutation(
    trpc.reviewMemory.approveAndOpenChangeRequest.mutationOptions({
      onError,
      onSettled,
      onSuccess: proposal => {
        announcingToast.success(
          i18n.t(
            proposal.status === 'superseded'
              ? 'codeReviewer.reviewMemory.alreadyPresent'
              : 'codeReviewer.reviewMemory.prOpened'
          )
        );
      },
    })
  );
  return {
    isPending: save.isPending || reject.isPending || approve.isPending,
    save: async (proposalId: string, draft: ProposalDraft) => {
      const proposal = await save.mutateAsync({ ...ownerInput, proposalId, ...draft });
      return proposal;
    },
    reject: async (proposalId: string) => {
      const proposal = await reject.mutateAsync({ ...ownerInput, proposalId });
      return proposal;
    },
    approve: async (proposalId: string) => {
      const proposal = await approve.mutateAsync({ ...ownerInput, proposalId });
      return proposal;
    },
  };
}
