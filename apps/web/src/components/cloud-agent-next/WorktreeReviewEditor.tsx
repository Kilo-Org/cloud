'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import type { FileDiffProps } from '@pierre/diffs/react';
import type { WorktreeFileRecord } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { MessageSquarePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { worktreeFileOmissionMessages } from './worktree-file';
import {
  createWorktreeReviewAnchor,
  MAX_WORKTREE_REVIEW_COMMENTS,
  MAX_WORKTREE_REVIEW_COMMENT_LENGTH,
  normalizeWorktreeReviewRange,
  sameWorktreeReviewCapture,
  sameWorktreeReviewScope,
  type WorktreeReviewAnchor,
  type WorktreeReviewCapture,
  type WorktreeReviewComment,
  type WorktreeReviewResult,
} from './worktree-review';
import {
  formatWorktreeReviewRange,
  getWorktreeReviewAnnotations,
  type WorktreeFileReviewBindings,
  type WorktreeReviewEditor as ReviewEditorState,
} from './worktree-review-bindings';
import {
  bindWorktreeReviewSelection,
  validateWorktreeReviewRenderedRange,
  worktreeReviewKeyboardInstructions,
} from './worktree-review-selection';

export type WorktreeReviewDiffProps = Pick<
  FileDiffProps<WorktreeReviewComment[]>,
  'options' | 'selectedLines' | 'lineAnnotations' | 'renderAnnotation' | 'renderGutterUtility'
>;

function ReviewQuote({ anchor }: { anchor: WorktreeReviewAnchor }) {
  return (
    <figure className="min-w-0 space-y-2">
      <figcaption className="text-muted-foreground text-xs">
        {formatWorktreeReviewRange(anchor.range)} · Saved revision {anchor.capture.revision}
      </figcaption>
      <pre
        tabIndex={0}
        aria-label="Quoted saved lines"
        className="bg-muted focus-visible:ring-ring max-h-48 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap break-all focus-visible:ring-2 focus-visible:outline-none"
      >
        {anchor.quote.lines.map(line => (
          <span key={line.lineNumber} className="block">
            <span className="text-muted-foreground select-none">
              {line.lineNumber}{' '}
              {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' '}{' '}
            </span>
            {line.text.replace(/\n$/, '')}
          </span>
        ))}
      </pre>
    </figure>
  );
}

function ReviewCommentForm({
  editor,
  review,
  capture,
  onClose,
}: {
  editor: ReviewEditorState;
  review: WorktreeFileReviewBindings;
  capture: WorktreeReviewCapture;
  onClose: () => void;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => textarea.current?.focus(), []);
  const tooLong = editor.text.length > MAX_WORKTREE_REVIEW_COMMENT_LENGTH;
  const error = tooLong
    ? `Use no more than ${MAX_WORKTREE_REVIEW_COMMENT_LENGTH} characters.`
    : review.error;
  return (
    <form
      className="min-w-0 space-y-4"
      onSubmit={event => {
        event.preventDefault();
        if (!review.disabledReason && editor.text.trim() && !tooLong) review.onSaveEditor();
      }}
    >
      <p className="font-mono text-xs break-all">{editor.anchor.path}</p>
      {!sameWorktreeReviewCapture(editor.anchor.capture, capture) && (
        <p role="status" className="text-muted-foreground text-sm">
          This comment is not from the displayed capture. Its original quote is unchanged.
        </p>
      )}
      <ReviewQuote anchor={editor.anchor} />
      <div className="space-y-2">
        <Label htmlFor={`${id}-text`}>Feedback</Label>
        <Textarea
          ref={textarea}
          id={`${id}-text`}
          className="min-h-28 text-base sm:text-sm"
          rows={4}
          value={editor.text}
          maxLength={MAX_WORKTREE_REVIEW_COMMENT_LENGTH}
          disabled={!!review.disabledReason}
          aria-invalid={!!error}
          aria-describedby={`${id}-help ${id}-error`}
          onChange={event => review.onEditorChange({ ...editor, text: event.target.value })}
        />
        <p id={`${id}-help`} className="text-muted-foreground text-xs">
          {editor.text.length}/{MAX_WORKTREE_REVIEW_COMMENT_LENGTH} characters. Saved to your
          review, not sent to the agent yet.
        </p>
        <p
          id={`${id}-error`}
          role={error ? 'alert' : undefined}
          className="text-destructive text-sm"
        >
          {error}
        </p>
      </div>
      {review.disabledReason && (
        <p role="status" className="text-muted-foreground text-sm">
          {review.disabledReason}
        </p>
      )}
      <DialogFooter className="flex-wrap gap-2 sm:space-x-0">
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={!!review.disabledReason}
          onClick={() => {
            review.onEditorChange(null);
            onClose();
          }}
        >
          {editor.commentId ? 'Cancel edit' : 'Discard comment'}
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={onClose}>
          Close
        </Button>
        <Button
          type="submit"
          className="min-h-11"
          disabled={!!review.disabledReason || !editor.text.trim() || tooLong}
        >
          Save comment
        </Button>
      </DialogFooter>
    </form>
  );
}

export function WorktreeReviewEditor({
  file,
  diff,
  capture,
  review,
  renderStatus,
  children,
}: {
  file: WorktreeFileRecord;
  diff: FileDiffMetadata | null;
  capture: WorktreeReviewCapture;
  review: WorktreeFileReviewBindings;
  renderStatus: 'loading' | 'ready' | 'error';
  children: (props: WorktreeReviewDiffProps) => ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const [selectionError, setSelectionError] = useState<string>();
  const opening = useRef(false);
  const renderedRoot = useRef<ShadowRoot | null>(null);
  const cleanupSelection = useRef<(() => void) | undefined>(undefined);
  const editor =
    review.editor && sameWorktreeReviewScope(review.editor.anchor.capture, capture)
      ? review.editor
      : null;
  const unavailableReason =
    file.diff.status === 'omitted'
      ? `Diff omitted. ${worktreeFileOmissionMessages[file.diff.reason]}`
      : !diff
        ? 'This saved diff could not be rendered.'
        : diff.hunks.length === 0
          ? 'This saved file has no reviewable diff lines.'
          : file.content.status === 'unavailable' && file.content.reason === 'binary'
            ? 'Binary files have no reviewable diff lines.'
            : undefined;
  const newCommentDisabled =
    review.disabledReason ??
    unavailableReason ??
    (renderStatus === 'error'
      ? 'New comments are unavailable because this saved diff could not be rendered. Reload the page to try again.'
      : renderStatus !== 'ready'
        ? 'Wait for the saved diff viewer before commenting on new lines.'
        : undefined) ??
    (review.editor
      ? 'Finish or discard your open comment before selecting other lines.'
      : undefined) ??
    (review.comments.length >= MAX_WORKTREE_REVIEW_COMMENTS
      ? `A review can contain no more than ${MAX_WORKTREE_REVIEW_COMMENTS} comments.`
      : undefined);
  const annotations = useMemo(
    () => getWorktreeReviewAnnotations(review.comments, capture, file.path),
    [review.comments, capture, file.path]
  );
  useEffect(() => {
    opening.current = !!review.editor;
    if (!editor) {
      setDialogOpen(false);
      setSelectedLines(null);
    }
  }, [review.editor, editor]);

  useEffect(
    () => () => {
      cleanupSelection.current?.();
      renderedRoot.current = null;
    },
    []
  );

  const applySelection = useCallback((result: WorktreeReviewResult<SelectedLineRange | null>) => {
    setSelectedLines(result.ok ? result.value : null);
    setSelectionError(result.ok ? undefined : result.error);
  }, []);

  const selectLines = useCallback(
    (selection: SelectedLineRange | null) => {
      if (!selection) {
        applySelection({ ok: true, value: null });
        return;
      }
      const root = renderedRoot.current;
      if (!root?.host.isConnected) return;
      applySelection(validateWorktreeReviewRenderedRange(root, selection));
    },
    [applySelection]
  );

  const openComment = useCallback(
    (selection: SelectedLineRange) => {
      if (opening.current || newCommentDisabled || !diff) return;
      const root = renderedRoot.current;
      if (!root?.host.isConnected) return;
      const rendered = validateWorktreeReviewRenderedRange(root, selection);
      if (!rendered.ok || !rendered.value) {
        applySelection(rendered);
        return;
      }
      const range = normalizeWorktreeReviewRange(rendered.value);
      if (!range.ok) {
        setSelectionError(range.error);
        return;
      }
      const anchor = createWorktreeReviewAnchor({ capture, file, diff, range: range.value });
      if (!anchor.ok) {
        setSelectionError(anchor.error);
        return;
      }
      opening.current = true;
      applySelection(rendered);
      review.onEditorChange({ anchor: anchor.value, text: '' });
      setDialogOpen(true);
    },
    [newCommentDisabled, diff, capture, file, review, applySelection]
  );

  const options = useMemo<WorktreeReviewDiffProps['options']>(
    () => ({
      enableLineSelection: !newCommentDisabled,
      enableGutterUtility: false,
      onLineSelectionStart: selectLines,
      onLineSelectionChange: selectLines,
      onLineSelectionEnd: selection => {
        if (selection) openComment(selection);
        else setSelectedLines(null);
      },
      onPostRender: (node, _instance, phase) => {
        cleanupSelection.current?.();
        cleanupSelection.current = undefined;
        renderedRoot.current = phase === 'unmount' ? null : node.shadowRoot;
        if (phase === 'unmount') applySelection({ ok: true, value: null });
        if (renderedRoot.current && !newCommentDisabled) {
          cleanupSelection.current = bindWorktreeReviewSelection(
            renderedRoot.current,
            applySelection,
            openComment
          );
        }
      },
    }),
    [newCommentDisabled, selectLines, applySelection, openComment]
  );

  const selection = selectedLines ? normalizeWorktreeReviewRange(selectedLines) : null;
  const canComment = !newCommentDisabled && !selectionError && !!selectedLines;
  return (
    <>
      <div className="shrink-0 space-y-1 border-b px-3 py-1">
        <div className="flex flex-wrap items-center gap-2">
          <p id={`${id}-help`} className="text-muted-foreground min-w-0 flex-1 text-xs">
            Drag line numbers to comment, or select code and choose Comment.
            <span className="sr-only"> {worktreeReviewKeyboardInstructions}</span>
          </p>
          <Button
            ref={trigger}
            type="button"
            variant="outline"
            className="min-h-11 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            aria-disabled={!canComment}
            aria-describedby={newCommentDisabled ? `${id}-disabled` : `${id}-help`}
            onPointerDown={event => {
              if (canComment) event.preventDefault();
            }}
            onClick={() => {
              if (canComment && selectedLines) openComment(selectedLines);
            }}
          >
            <MessageSquarePlus aria-hidden="true" />
            Comment
          </Button>
          {editor && (
            <Button
              type="button"
              variant="secondary"
              className="min-h-11 text-xs"
              onClick={() => setDialogOpen(true)}
            >
              Continue comment
            </Button>
          )}
          <span role="status" className="text-muted-foreground text-xs">
            {selection?.ok
              ? selection.value.startLine === selection.value.endLine
                ? 'Line selected'
                : `${selection.value.endLine - selection.value.startLine + 1} lines selected`
              : ''}
          </span>
        </div>
        {newCommentDisabled && (
          <p id={`${id}-disabled`} className="text-muted-foreground text-xs">
            {newCommentDisabled}
          </p>
        )}
        {selectionError && (
          <p role="alert" className="text-destructive text-xs">
            {selectionError}
          </p>
        )}
      </div>
      {children({
        selectedLines,
        options,
        lineAnnotations: unavailableReason ? [] : annotations,
        renderAnnotation: annotation => (
          <Card className="m-2 min-w-0 p-3 font-sans text-sm shadow-none">
            <ol className="space-y-3">
              {annotation.metadata.map(comment => (
                <li key={comment.id} className="space-y-1">
                  <p className="text-muted-foreground text-xs">
                    {formatWorktreeReviewRange(comment.anchor.range)}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{comment.text}</p>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11 text-xs"
                      disabled={
                        !!review.disabledReason ||
                        (!!review.editor && editor?.commentId !== comment.id)
                      }
                      onClick={() => {
                        opening.current = true;
                        applySelection({
                          ok: true,
                          value: {
                            side: comment.anchor.range.side,
                            start: comment.anchor.range.startLine,
                            end: comment.anchor.range.endLine,
                          },
                        });
                        if (editor?.commentId !== comment.id) {
                          review.onEditorChange({
                            commentId: comment.id,
                            anchor: comment.anchor,
                            text: comment.text,
                          });
                        }
                        setDialogOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11 text-xs"
                      disabled={!!review.disabledReason || !!review.editor}
                      onClick={() => review.onRemoveComment(comment.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        ),
      })}
      <Dialog open={dialogOpen && editor !== null} onOpenChange={setDialogOpen}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
          onCloseAutoFocus={event => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Review comment</DialogTitle>
            <DialogDescription>
              Closing keeps your text while you switch files or tabs. Reloading this page loses the
              draft.
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <ReviewCommentForm
              editor={editor}
              review={review}
              capture={capture}
              onClose={() => setDialogOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
