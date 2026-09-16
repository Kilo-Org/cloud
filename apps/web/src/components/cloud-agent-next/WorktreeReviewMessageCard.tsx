'use client';

import React, { useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { type ParsedWorktreeReview } from './worktree-review';
import { WorktreeReviewList } from './WorktreeReviewList';

export function WorktreeReviewMessageCard({ review }: { review: ParsedWorktreeReview }) {
  const [open, setOpen] = useState(false);
  const commentCount = review.comments.length;
  const fileCount = new Set(review.comments.map(comment => comment.anchor.path)).size;
  const summary = `${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="focus-visible:ring-ring flex w-full min-w-0 cursor-pointer flex-col items-start gap-1 bg-transparent p-0 text-left focus-visible:ring-2 focus-visible:outline-none"
          aria-label={`Code review feedback, ${summary}`}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <MessageSquareText className="size-4 shrink-0" aria-hidden="true" />
            Code review feedback
          </span>
          <span className="text-primary-foreground/70 text-xs">{summary}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90dvh] min-w-0 flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Code review feedback ({review.comments.length})</DialogTitle>
          <DialogDescription>
            Read-only details from the review sent to the agent.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-5 overflow-y-auto pr-1">
          {review.overall && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Overall comment</h3>
              <p className="text-sm whitespace-pre-wrap break-words">{review.overall}</p>
            </section>
          )}
          <WorktreeReviewList comments={review.comments} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
