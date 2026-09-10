'use client';

import React, { type ReactNode } from 'react';
import { WorktreeReviewCommentForm } from './WorktreeReviewCommentForm';
import { type WorktreeReviewComment, type WorktreeReviewFreshness } from './worktree-review';
import { formatWorktreeReviewRange, type WorktreeReviewEditor } from './worktree-review-bindings';

export type WorktreeReviewListProps = {
  comments: readonly WorktreeReviewComment[];
  freshness?: ReadonlyMap<string, WorktreeReviewFreshness>;
  showFreshness?: boolean;
  renderActions?: (comment: WorktreeReviewComment) => ReactNode;
  editor?: WorktreeReviewEditor | null;
  editorError?: string;
  editorDisabled?: boolean;
  onEditorChange?: (editor: WorktreeReviewEditor | null) => void;
  onSaveEditor?: () => void;
  onOpenComment?: (comment: WorktreeReviewComment) => void;
  compact?: boolean;
};

function freshnessLabel(freshness: WorktreeReviewFreshness | undefined): string {
  return freshness === 'current'
    ? 'Current saved capture'
    : freshness === 'stale'
      ? 'Older saved capture'
      : 'Capture freshness unknown';
}

function groupCommentsByPath(
  comments: readonly WorktreeReviewComment[]
): Array<{ path: string; comments: WorktreeReviewComment[] }> {
  const groups: Array<{ path: string; comments: WorktreeReviewComment[] }> = [];
  const indexByPath = new Map<string, number>();
  for (const comment of comments) {
    const path = comment.anchor.path;
    const index = indexByPath.get(path);
    if (index === undefined) {
      indexByPath.set(path, groups.length);
      groups.push({ path, comments: [comment] });
      continue;
    }
    const group = groups[index];
    if (group) group.comments.push(comment);
  }
  return groups;
}

function ReviewEditorRow({
  editor,
  error,
  disabled,
  onChange,
  onSave,
}: {
  editor: WorktreeReviewEditor;
  error?: string;
  disabled: boolean;
  onChange: (editor: WorktreeReviewEditor | null) => void;
  onSave: () => void;
}) {
  return (
    <article className="space-y-3" aria-label="Unsaved review comment">
      <WorktreeReviewCommentForm
        editor={editor}
        error={error}
        disabled={disabled}
        onChange={onChange}
        onSave={onSave}
        containerClassName="space-y-3"
        formClassName="space-y-2"
        header={
          <div className="space-y-1">
            <p className="font-mono text-sm break-all">{editor.anchor.path}</p>
            <p className="text-muted-foreground text-xs">
              {formatWorktreeReviewRange(editor.anchor.range)}
            </p>
          </div>
        }
      />
    </article>
  );
}

export function WorktreeReviewList({
  comments,
  freshness,
  showFreshness = false,
  renderActions,
  editor,
  editorError,
  editorDisabled = false,
  onEditorChange,
  onSaveEditor,
  onOpenComment,
  compact = false,
}: WorktreeReviewListProps) {
  const listSpacing = compact ? 'space-y-4' : 'space-y-5';
  const renderEditor =
    editor && onEditorChange && onSaveEditor ? (
      <ReviewEditorRow
        key={`editor:${editor.anchor.range.side}:${editor.anchor.range.endLine}`}
        editor={editor}
        error={editorError}
        disabled={editorDisabled}
        onChange={onEditorChange}
        onSave={onSaveEditor}
      />
    ) : null;
  const groups = groupCommentsByPath(comments);

  return (
    <div className={listSpacing} aria-label="Worktree review comments">
      {groups.map(group => (
        <section key={group.path} className="space-y-2" aria-label={`Comments on ${group.path}`}>
          <h3 className="font-mono text-sm break-all">{group.path}</h3>
          <ol className="space-y-2">
            {group.comments.map(comment => {
              const status = freshness?.get(comment.id);
              const editing = editor?.commentId === comment.id;
              const openComment = onOpenComment ? () => onOpenComment(comment) : undefined;
              return (
                <li key={comment.id}>
                  {editing ? (
                    renderEditor
                  ) : (
                    <article
                      className={[
                        'bg-muted/40 space-y-2 rounded-md border px-3 py-2',
                        onOpenComment
                          ? 'cursor-pointer focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-label={`${formatWorktreeReviewRange(comment.anchor.range)} on ${comment.anchor.path}`}
                      role={onOpenComment ? 'button' : undefined}
                      tabIndex={onOpenComment ? 0 : undefined}
                      onClick={openComment}
                      onKeyDown={
                        onOpenComment
                          ? event => {
                              if (event.key !== 'Enter' && event.key !== ' ') return;
                              event.preventDefault();
                              onOpenComment(comment);
                            }
                          : undefined
                      }
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="text-muted-foreground text-xs">
                          {formatWorktreeReviewRange(comment.anchor.range)}
                        </p>
                        {showFreshness && (
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {freshnessLabel(status)}
                          </span>
                        )}
                      </div>
                      <p className="text-sm whitespace-pre-wrap break-words">{comment.text}</p>
                      {!onOpenComment && renderActions?.(comment)}
                    </article>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {editor && !comments.some(comment => comment.id === editor.commentId) && renderEditor}
    </div>
  );
}
