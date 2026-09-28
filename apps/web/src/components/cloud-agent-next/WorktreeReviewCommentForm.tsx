'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MAX_WORKTREE_REVIEW_COMMENT_LENGTH } from './worktree-review';
import type { WorktreeReviewEditor } from './worktree-review-bindings';

export function WorktreeReviewCommentForm({
  editor,
  header,
  error,
  disabled = false,
  disabledReason,
  onChange,
  onSave,
  containerClassName = 'min-w-0 space-y-4',
  formClassName = 'space-y-4',
  textareaClassName,
}: {
  editor: WorktreeReviewEditor;
  header?: ReactNode;
  error?: string;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (editor: WorktreeReviewEditor | null) => void;
  onSave: () => void;
  containerClassName?: string;
  formClassName?: string;
  textareaClassName?: string;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => textarea.current?.focus(), []);
  const tooLong = editor.text.length > MAX_WORKTREE_REVIEW_COMMENT_LENGTH;
  const fieldError = tooLong
    ? `Use no more than ${MAX_WORKTREE_REVIEW_COMMENT_LENGTH} characters.`
    : error;
  const isDisabled = disabled || Boolean(disabledReason);
  return (
    <div className={containerClassName}>
      {header}
      <form
        className={formClassName}
        onSubmit={event => {
          event.preventDefault();
          if (!isDisabled && editor.text.trim() && !tooLong) onSave();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor={`${id}-text`}>Comment</Label>
          <Textarea
            ref={textarea}
            id={`${id}-text`}
            className={textareaClassName}
            rows={4}
            value={editor.text}
            maxLength={MAX_WORKTREE_REVIEW_COMMENT_LENGTH}
            disabled={isDisabled}
            aria-invalid={Boolean(fieldError)}
            aria-describedby={`${id}-error`}
            onChange={event => onChange({ ...editor, text: event.target.value })}
            onKeyDown={event => {
              if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
          />
          <p
            id={`${id}-error`}
            role={fieldError ? 'alert' : undefined}
            className="text-destructive text-sm"
          >
            {fieldError}
          </p>
        </div>
        {disabledReason && (
          <p role="status" className="text-muted-foreground text-sm">
            {disabledReason}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" className="min-h-11" onClick={() => onChange(null)}>
            Cancel
          </Button>
          <Button
            type="submit"
            className="min-h-11"
            disabled={isDisabled || !editor.text.trim() || tooLong}
          >
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}
