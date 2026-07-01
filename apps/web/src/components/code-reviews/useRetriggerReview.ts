import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTRPC } from '@/lib/trpc/utils';

type UseRetriggerReviewOptions = {
  onRetriggered: () => Promise<void> | void;
};

export function useRetriggerReview(
  reviewId: string | undefined,
  { onRetriggered }: UseRetriggerReviewOptions
) {
  const trpc = useTRPC();
  const [confirmOpen, setConfirmOpenState] = useState(false);
  const [confirmReviewId, setConfirmReviewId] = useState<string | null>(null);

  const retriggerMutation = useMutation(
    trpc.codeReviews.retrigger.mutationOptions({
      onSuccess: async (result, variables) => {
        if (!result.success) {
          toast.error('Failed to retrigger code review', {
            description: String(result.error ?? 'Failed to retrigger code review'),
          });
          return;
        }

        if (result.outcome === 'confirm_cancel_active') {
          setConfirmReviewId(variables.reviewId);
          setConfirmOpenState(true);
          return;
        }

        setConfirmReviewId(null);
        setConfirmOpenState(false);
        toast.success('Code review retriggered', {
          description: 'The code review has been queued for processing.',
        });
        await onRetriggered();
      },
      onError: error => {
        toast.error('Failed to retrigger code review', { description: error.message });
      },
    })
  );

  function setConfirmOpen(open: boolean) {
    setConfirmOpenState(open);
    if (!open && !retriggerMutation.isPending) {
      setConfirmReviewId(null);
    }
  }

  function retriggerReview(nextReviewId = reviewId) {
    if (!nextReviewId) return;
    retriggerMutation.mutate({ reviewId: nextReviewId });
  }

  function confirmCancelAndRetry() {
    const nextReviewId = confirmReviewId ?? reviewId;
    if (!nextReviewId) return;
    retriggerMutation.mutate({ reviewId: nextReviewId, cancelActiveReview: true });
  }

  return {
    retriggerReview,
    confirmOpen,
    setConfirmOpen,
    confirmCancelAndRetry,
    isPending: retriggerMutation.isPending,
    pendingReviewId: retriggerMutation.variables?.reviewId ?? null,
  };
}
