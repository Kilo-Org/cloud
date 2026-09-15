'use client';

import { useId } from 'react';
import { MessageSquareText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { MAX_WORKTREE_REVIEW_COMMENT_LENGTH, type WorktreeReviewComment } from './worktree-review';
import type { useWorktreeReview } from './useWorktreeReview';
import { WorktreeReviewList } from './WorktreeReviewList';

export function WorktreeReviewDialog({
  review,
  onOpenComment,
}: {
  review: ReturnType<typeof useWorktreeReview>;
  onOpenComment: (comment: WorktreeReviewComment) => void;
}) {
  const overallId = useId();
  const draft = review.draft;
  if (!review.visible || !draft) return null;
  const busy = draft.delivery.phase === 'preparing' || draft.delivery.phase === 'sending';
  const unresolved = draft.delivery.phase === 'unknown';
  const destinationExists = review.destinations.some(
    destination => destination.sessionId === draft.destinationKiloSessionId
  );
  const sendDisabled =
    !review.canSubmit ||
    busy ||
    (!unresolved &&
      (Boolean(review.disabledReason) ||
        !destinationExists ||
        draft.comments.length === 0 ||
        draft.editor !== null));

  return (
    <Dialog open={review.open} onOpenChange={review.setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 shrink-0 gap-1.5 px-2 sm:h-8"
          aria-label={`Review feedback, ${draft.comments.length} pending comments${draft.editor ? ', unsaved edit' : ''}`}
        >
          <MessageSquareText className="size-4" aria-hidden="true" />
          <span>Review</span>
          <span className="font-mono tabular-nums">
            {draft.comments.length}
            {draft.editor ? '*' : ''}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90dvh] min-w-0 flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review {draft.comments.length}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          <div className="space-y-2">
            <Label htmlFor={overallId}>Summary</Label>
            <Textarea
              id={overallId}
              value={draft.overall}
              rows={3}
              maxLength={MAX_WORKTREE_REVIEW_COMMENT_LENGTH}
              disabled={review.locked}
              onChange={event => review.setOverall(event.target.value)}
            />
          </div>
          <WorktreeReviewList
            comments={draft.comments}
            compact
            onOpenComment={comment => onOpenComment(comment)}
          />
        </div>
        <div className="shrink-0 space-y-2 text-sm" aria-live="polite">
          {review.disabledReason && (
            <p className="text-muted-foreground">{review.disabledReason}</p>
          )}
          {unresolved && (
            <p>
              Delivery is not confirmed. Editing is locked. Retry checks or resends the same batch
              to the same chat; do not start another review for this feedback.
            </p>
          )}
          {draft.error && (
            <p id="worktree-review-error" role="alert" className="text-destructive">
              {draft.error}
            </p>
          )}
        </div>
        <DialogFooter className="mt-auto shrink-0 gap-2 border-t pt-4 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 sm:min-h-8"
            disabled={review.locked || unresolved}
            onClick={review.discardDraft}
          >
            Discard review
          </Button>
          <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:items-center">
            {review.destinations.length > 1 && (
              <Select
                value={draft.destinationKiloSessionId ?? ''}
                onValueChange={review.setDestination}
                disabled={review.locked || review.destinations.length === 0}
              >
                <SelectTrigger
                  aria-label="Destination chat"
                  className="w-full min-w-0 data-[size=default]:h-11 sm:w-auto sm:data-[size=default]:h-9"
                >
                  <SelectValue placeholder="Choose a chat in this worktree" />
                </SelectTrigger>
                <SelectContent>
                  {draft.destinationKiloSessionId && !destinationExists && (
                    <SelectItem value={draft.destinationKiloSessionId} disabled>
                      Selected chat unavailable
                    </SelectItem>
                  )}
                  {review.destinations.map(destination => (
                    <SelectItem
                      key={destination.sessionId}
                      value={destination.sessionId}
                      className="min-h-11 sm:min-h-8"
                    >
                      <span className="min-w-0 truncate">{destination.title}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              type="button"
              className="min-h-11 sm:min-h-8"
              disabled={sendDisabled}
              onClick={() => void review.send()}
            >
              {busy ? 'Sending review…' : unresolved ? 'Retry same review' : 'Send review'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
