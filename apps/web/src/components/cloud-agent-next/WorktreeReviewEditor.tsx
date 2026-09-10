'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import type { FileDiffProps } from '@pierre/diffs/react';
import type { WorktreeFileRecord } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { worktreeFileOmissionMessages } from './worktree-file';
import { WorktreeReviewCommentForm } from './WorktreeReviewCommentForm';
import {
  createWorktreeReviewAnchor,
  MAX_WORKTREE_REVIEW_COMMENTS,
  normalizeWorktreeReviewRange,
  rebaseWorktreeReviewComment,
  rebaseWorktreeReviewCommentsForFile,
  sameWorktreeReviewCapture,
  sameWorktreeReviewScope,
  type WorktreeReviewCapture,
  type WorktreeReviewResult,
} from './worktree-review';
import {
  formatWorktreeReviewRange,
  getWorktreeReviewAnnotations,
  getWorktreeReviewSelectedLines,
  worktreeReviewEditorSlot,
  worktreeReviewRangeHighlightCSS,
  type WorktreeReviewAnnotationItem,
  type WorktreeFileReviewBindings,
} from './worktree-review-bindings';
import { validateWorktreeReviewRenderedRange } from './worktree-review-selection';

export type WorktreeReviewDiffProps = Pick<
  FileDiffProps<WorktreeReviewAnnotationItem[]>,
  'options' | 'selectedLines' | 'lineAnnotations' | 'renderAnnotation'
>;

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
  const [draggedLines, setDraggedLines] = useState<SelectedLineRange | null>(null);
  const [selectionError, setSelectionError] = useState<string>();
  const opening = useRef(false);
  const renderedRoot = useRef<ShadowRoot | null>(null);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const stableCaptureRef = useRef(capture);
  if (!sameWorktreeReviewCapture(stableCaptureRef.current, capture)) {
    stableCaptureRef.current = capture;
  }
  const stableCapture = stableCaptureRef.current;
  const editor =
    review.editor && sameWorktreeReviewScope(review.editor.anchor.capture, stableCapture)
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
  const editorSlot = worktreeReviewEditorSlot(editor, file.path, stableCapture);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const annotations = useMemo(
    () =>
      getWorktreeReviewAnnotations(review.comments, stableCapture, file.path, editorRef.current),
    [review.comments, stableCapture, file.path, editorSlot]
  );
  const selectedLines = useMemo(
    () => getWorktreeReviewSelectedLines(stableCapture, file.path, editor, draggedLines),
    [stableCapture, file.path, editor, draggedLines]
  );
  const highlightCSS = useMemo(
    () => worktreeReviewRangeHighlightCSS(review.comments, stableCapture, file.path),
    [review.comments, stableCapture, file.path]
  );
  useEffect(() => {
    opening.current = !!review.editor;
    if (editor) setDraggedLines(null);
  }, [review.editor, editor]);
  useEffect(() => {
    if (renderStatus !== 'ready') return;
    const replace = reviewRef.current.onReplacePathComments;
    if (!replace) return;
    const next = rebaseWorktreeReviewCommentsForFile(
      review.comments,
      stableCapture,
      file,
      !unavailableReason ? diff : null
    ).filter(comment => comment.anchor.path === file.path);
    const current = review.comments.filter(comment => comment.anchor.path === file.path);
    if (
      current.length === next.length &&
      current.every(
        (comment, index) =>
          comment.id === next[index]?.id &&
          sameWorktreeReviewCapture(comment.anchor.capture, next[index].anchor.capture)
      )
    ) {
      return;
    }
    replace(file.path, next);
  }, [diff, file, renderStatus, review.comments, stableCapture, unavailableReason]);
  useEffect(() => {
    if (!editor || editor.anchor.path !== file.path) return;
    if (sameWorktreeReviewCapture(editor.anchor.capture, stableCapture)) return;
    if (renderStatus !== 'ready') return;
    if (!diff || unavailableReason) {
      reviewRef.current.onEditorChange(null);
      return;
    }
    const next = rebaseWorktreeReviewComment(
      { id: editor.commentId ?? 'editor', anchor: editor.anchor, text: editor.text || '.' },
      stableCapture,
      file,
      diff
    );
    reviewRef.current.onEditorChange(next ? { ...editor, anchor: next.anchor } : null);
  }, [diff, editor, file, renderStatus, stableCapture, unavailableReason]);

  useEffect(
    () => () => {
      renderedRoot.current = null;
    },
    []
  );

  const applySelection = useCallback((result: WorktreeReviewResult<SelectedLineRange | null>) => {
    setDraggedLines(result.ok ? result.value : null);
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
      const anchor = createWorktreeReviewAnchor({
        capture: stableCapture,
        file,
        diff,
        range: range.value,
      });
      if (!anchor.ok) {
        setSelectionError(anchor.error);
        return;
      }
      opening.current = true;
      applySelection(rendered);
      reviewRef.current.onEditorChange({ anchor: anchor.value, text: '' });
    },
    [newCommentDisabled, diff, stableCapture, file, applySelection]
  );

  const options = useMemo<WorktreeReviewDiffProps['options']>(
    () => ({
      enableLineSelection: false,
      enableGutterUtility: !newCommentDisabled,
      unsafeCSS: highlightCSS,
      onGutterUtilityClick: selection => openComment(selection),
      onLineSelectionStart: selectLines,
      onLineSelectionChange: selectLines,
      onLineSelectionEnd: selection => {
        if (!selection) setDraggedLines(null);
      },
      onPostRender: (node, _instance, phase) => {
        renderedRoot.current = phase === 'unmount' ? null : node.shadowRoot;
        if (phase === 'unmount') applySelection({ ok: true, value: null });
      },
    }),
    [applySelection, highlightCSS, newCommentDisabled, openComment, selectLines]
  );

  const renderAnnotation = useCallback(
    (annotation: NonNullable<WorktreeReviewDiffProps['lineAnnotations']>[number]) => (
      <Card className="m-2 min-w-0 p-3 font-sans text-sm shadow-none">
        <ol className="space-y-3">
          {annotation.metadata.map(item => {
            if (item.kind === 'editor') {
              const currentEditor = reviewRef.current.editor;
              if (!currentEditor) return null;
              const slot = worktreeReviewEditorSlot(currentEditor, file.path, stableCapture);
              if (!slot || slot !== `${annotation.side}:${annotation.lineNumber}`) return null;
              return (
                <li key={`editor:${slot}`} className="space-y-1">
                  <WorktreeReviewCommentForm
                    key={slot}
                    editor={currentEditor}
                    error={reviewRef.current.error}
                    disabledReason={reviewRef.current.disabledReason}
                    onChange={reviewRef.current.onEditorChange}
                    onSave={reviewRef.current.onSaveEditor}
                    textareaClassName="min-h-28 text-base sm:text-sm"
                  />
                </li>
              );
            }
            const comment = item.comment;
            const currentReview = reviewRef.current;
            const actionsDisabled = !!currentReview.disabledReason || !!currentReview.editor;
            return (
              <li key={comment.id} className="space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-muted-foreground text-xs">
                    {formatWorktreeReviewRange(comment.anchor.range)}
                  </p>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground"
                        disabled={actionsDisabled}
                        aria-label="Comment actions"
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={actionsDisabled}
                        onSelect={() => {
                          opening.current = true;
                          currentReview.onEditorChange({
                            commentId: comment.id,
                            anchor: comment.anchor,
                            text: comment.text,
                          });
                        }}
                      >
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={actionsDisabled}
                        onSelect={() => currentReview.onRemoveComment(comment.id)}
                      >
                        Discard
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <p className="whitespace-pre-wrap break-words">{comment.text}</p>
              </li>
            );
          })}
        </ol>
      </Card>
    ),
    [stableCapture, file.path]
  );
  return (
    <>
      {(newCommentDisabled || selectionError) && (
        <div className="shrink-0 space-y-1 px-3 py-1">
          {newCommentDisabled && (
            <p id={`${id}-disabled`} role="status" className="text-muted-foreground text-xs">
              {newCommentDisabled}
            </p>
          )}
          {selectionError && (
            <p role="alert" className="text-destructive text-xs">
              {selectionError}
            </p>
          )}
        </div>
      )}
      {children({
        selectedLines,
        options,
        lineAnnotations: unavailableReason ? [] : annotations,
        renderAnnotation,
      })}
    </>
  );
}
