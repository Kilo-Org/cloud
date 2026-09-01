'use client';

import { useId } from 'react';
import { MessageSquareText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  MAX_WORKTREE_REVIEW_COMMENT_LENGTH,
  type WorktreeReviewAnchor,
  type WorktreeReviewComment,
} from './worktree-review';
import type { WorktreeReviewEditor } from './worktree-review-bindings';
import type { useWorktreeReview } from './useWorktreeReview';

function SavedReviewQuote({ anchor }: { anchor: WorktreeReviewAnchor }) {
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs break-words">
        {anchor.range.side === 'deletions' ? 'Old side' : 'New side'} · Lines{' '}
        {anchor.range.startLine}–{anchor.range.endLine} · Capture {anchor.capture.revision}
      </p>
      <pre
        className="bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs"
        tabIndex={0}
        aria-label={`Saved quote from ${anchor.path}`}
      >
        <code>{anchor.quote.lines.map(line => line.text).join('')}</code>
      </pre>
      <details className="text-muted-foreground text-xs">
        <summary className="focus-visible:ring-ring cursor-pointer rounded py-2 focus-visible:ring-2">
          Saved capture details
        </summary>
        <dl className="grid gap-1 py-2 break-all">
          <dt>Captured at</dt>
          <dd>{anchor.capture.capturedAt}</dd>
          <dt>Source session</dt>
          <dd className="font-mono">{anchor.capture.sourceCloudAgentSessionId}</dd>
          <dt>Comparison</dt>
          <dd className="font-mono">{anchor.capture.comparison.baseRef}</dd>
          <dt>Merge base</dt>
          <dd className="font-mono">{anchor.capture.comparison.mergeBase}</dd>
          <dt>HEAD</dt>
          <dd className="font-mono">{anchor.capture.comparison.head}</dd>
        </dl>
      </details>
    </div>
  );
}

function ReviewEditor({
  editor,
  review,
}: {
  editor: WorktreeReviewEditor;
  review: ReturnType<typeof useWorktreeReview>;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Feedback</Label>
      <Textarea
        id={id}
        autoFocus
        value={editor.text}
        rows={4}
        maxLength={MAX_WORKTREE_REVIEW_COMMENT_LENGTH}
        disabled={review.locked || Boolean(review.disabledReason)}
        aria-describedby={review.draft?.error ? 'worktree-review-error' : undefined}
        onChange={event => review.setEditor({ ...editor, text: event.target.value })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          className="min-h-11 sm:min-h-8"
          disabled={review.locked || Boolean(review.disabledReason)}
          onClick={review.saveEditor}
        >
          Save comment
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 sm:min-h-8"
          disabled={review.locked}
          onClick={() => review.setEditor(null)}
        >
          Discard edit
        </Button>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {editor.text.length}/{MAX_WORKTREE_REVIEW_COMMENT_LENGTH}
        </span>
      </div>
    </div>
  );
}

export function WorktreeReviewDialog({
  review,
  onReviewAgain,
}: {
  review: ReturnType<typeof useWorktreeReview>;
  onReviewAgain: (comment: WorktreeReviewComment) => void;
}) {
  const destinationId = useId();
  const olderId = useId();
  const draft = review.draft;
  if (!review.visible || !draft) return null;
  const busy = draft.delivery.phase === 'preparing' || draft.delivery.phase === 'sending';
  const unresolved = draft.delivery.phase === 'unknown';
  const selectedDestination = review.destinations.find(
    destination => destination.sessionId === draft.destinationKiloSessionId
  );
  const destinationExists = Boolean(selectedDestination);
  const sendDisabled =
    !review.canSubmit ||
    busy ||
    (!unresolved &&
      (Boolean(review.disabledReason) ||
        !destinationExists ||
        draft.comments.length === 0 ||
        draft.editor !== null ||
        (review.olderCommentIds.length > 0 && !draft.allowOlderCapture)));

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
          <DialogTitle>Review feedback ({draft.comments.length})</DialogTitle>
          <DialogDescription>
            Send these comments together to one chat in this worktree. Drafts and unsaved edits stay
            only in this page’s memory, not browser storage. Reloading or leaving this page loses
            them, including retry state.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
          {draft.comments.length === 0 && !draft.editor && (
            <p className="text-muted-foreground text-sm">
              Select lines in a saved diff and add feedback to start a review.
            </p>
          )}
          {draft.editor && !draft.editor.commentId && (
            <section className="space-y-3" aria-label="Unsaved review comment">
              <h3 className="text-sm font-medium break-all">
                Unsaved comment · {draft.editor.anchor.path}
              </h3>
              <SavedReviewQuote anchor={draft.editor.anchor} />
              <ReviewEditor editor={draft.editor} review={review} />
            </section>
          )}
          {draft.comments.map((comment, index) => {
            const freshness = review.freshness.get(comment.id) ?? 'unknown';
            const editing = draft.editor?.commentId === comment.id ? draft.editor : null;
            const canReviewAgain = review.destinations.some(
              destination =>
                destination.cloudAgentSessionId === comment.anchor.capture.sourceCloudAgentSessionId
            );
            return (
              <article
                key={comment.id}
                className="space-y-3 border-b pb-4 last:border-b-0"
                aria-label={`Comment ${index + 1}: ${comment.anchor.path}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 font-mono text-sm break-all">{comment.anchor.path}</h3>
                  <span className="text-muted-foreground text-xs">
                    {freshness === 'current'
                      ? 'Current saved capture'
                      : freshness === 'stale'
                        ? 'Older saved capture'
                        : 'Capture freshness unknown'}
                  </span>
                </div>
                <SavedReviewQuote anchor={comment.anchor} />
                {editing ? (
                  <ReviewEditor editor={editing} review={review} />
                ) : (
                  <p className="text-sm whitespace-pre-wrap break-words">{comment.text}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  {!editing && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      disabled={
                        review.locked || Boolean(draft.editor) || Boolean(review.disabledReason)
                      }
                      onClick={() => review.editComment(comment)}
                    >
                      Edit feedback
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-11 sm:min-h-8"
                    disabled={review.locked}
                    onClick={() => review.removeComment(comment.id)}
                  >
                    Remove comment
                  </Button>
                  {freshness !== 'current' && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-8"
                      disabled={review.locked || !canReviewAgain || Boolean(draft.editor)}
                      onClick={() => onReviewAgain(comment)}
                    >
                      Discard and review again
                    </Button>
                  )}
                </div>
                {freshness !== 'current' && (
                  <p className="text-muted-foreground text-xs">
                    The quote above is the exact saved selection. Review again discards this comment
                    and opens the file so you can select current lines.
                  </p>
                )}
              </article>
            );
          })}
          <div className="space-y-2">
            <Label htmlFor={destinationId}>Destination chat</Label>
            <Select
              value={draft.destinationKiloSessionId ?? ''}
              onValueChange={review.setDestination}
              disabled={review.locked || review.destinations.length === 0}
            >
              <SelectTrigger
                id={destinationId}
                className="w-full min-w-0 data-[size=default]:h-11 sm:data-[size=default]:h-9"
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
            {draft.destinationKiloSessionId && (
              <p className="text-muted-foreground font-mono text-xs break-all">
                {draft.destinationKiloSessionId}
              </p>
            )}
          </div>
          {review.olderCommentIds.length > 0 && (
            <div className="space-y-1">
              <div className="flex min-h-11 items-center gap-2">
                <Checkbox
                  id={olderId}
                  checked={draft.allowOlderCapture}
                  onCheckedChange={review.setAllowOlderCapture}
                  disabled={review.locked}
                  aria-describedby={`${olderId}-description`}
                />
                <Label htmlFor={olderId}>Send older feedback</Label>
              </div>
              <p id={`${olderId}-description`} className="text-muted-foreground text-xs">
                {review.olderCommentIds.length}{' '}
                {review.olderCommentIds.length === 1 ? 'comment refers' : 'comments refer'} to older
                or unverified captures. This feedback will be labeled as older, without moving its
                saved anchors.
              </p>
            </div>
          )}
        </div>
        <div className="space-y-2 text-sm" aria-live="polite">
          <p className="text-muted-foreground text-xs break-words">
            To: {selectedDestination?.title ?? draft.destinationKiloSessionId ?? 'Choose a chat'}
          </p>
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
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 sm:min-h-8"
            onClick={() => review.setOpen(false)}
          >
            Keep reviewing
          </Button>
          <Button
            type="button"
            className="min-h-11 sm:min-h-8"
            disabled={sendDisabled}
            onClick={() => void review.send()}
          >
            {busy ? 'Sending review…' : unresolved ? 'Retry same review' : 'Send review to agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
