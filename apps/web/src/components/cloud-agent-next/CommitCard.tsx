'use client';

import { useState } from 'react';
import type { SessionCommit } from '@kilocode/cloud-agent-sdk';
import { GitCommitHorizontal } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function CommitDetails({ commit }: { commit: SessionCommit }) {
  const [subject, ...bodyLines] = commit.commitMessage.split('\n');
  const body = bodyLines.join('\n').replace(/^\n+/, '');
  const notPushed = commit.pushStatus === 'failed' || commit.pushStatus === 'not_attempted';

  return (
    <div className="flex flex-col gap-3 wrap-anywhere">
      <div className="space-y-2">
        <p className="text-sm leading-5 font-medium">{subject || 'Empty commit message'}</p>
        {body && (
          <p className="text-muted-foreground text-xs leading-5 whitespace-pre-wrap">{body}</p>
        )}
        {commit.commitMessageTruncated && (
          <p className="text-muted-foreground text-xs">Message truncated.</p>
        )}
      </div>
      <div className="text-muted-foreground flex flex-col gap-1 text-xs leading-5">
        <code className="text-[11px] select-all">{commit.commitHash}</code>
        <div className="flex items-center gap-2">
          <time dateTime={commit.committedAt} title={new Date(commit.committedAt).toLocaleString()}>
            {new Date(commit.committedAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
          {notPushed && (
            <>
              <span aria-hidden="true">·</span>
              <span className="whitespace-nowrap">Not pushed</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function CommitCard({ commit }: { commit: SessionCommit }) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const shortHash = commit.commitHash.slice(0, 7);
  const subject = commit.commitMessage.split('\n', 1)[0];

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={open => {
        setTooltipOpen(false);
        setPopoverOpen(open);
      }}
    >
      <Tooltip open={tooltipOpen && !popoverOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring my-1 flex min-h-6 min-w-0 max-w-full items-center gap-1.5 rounded-sm text-left text-xs focus-visible:ring-2 focus-visible:outline-none [@media(any-pointer:coarse)]:min-h-11"
              data-commit-hash={commit.commitHash}
              aria-label={`Commit ${shortHash} details`}
            >
              <GitCommitHorizontal className="size-3.5 shrink-0" aria-hidden="true" />
              <code className="shrink-0">{shortHash}</code>
              <span className="min-w-0 truncate">{subject || 'Empty commit subject'}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!popoverOpen && (
          <TooltipContent
            side="top"
            align="start"
            sideOffset={4}
            className="max-h-[min(24rem,var(--radix-tooltip-content-available-height))] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain p-4 text-left text-wrap"
          >
            <CommitDetails commit={commit} />
          </TooltipContent>
        )}
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        onCloseAutoFocus={() => queueMicrotask(() => setTooltipOpen(false))}
        aria-label={`Commit ${shortHash} details`}
        className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain p-4"
      >
        <CommitDetails commit={commit} />
      </PopoverContent>
    </Popover>
  );
}
