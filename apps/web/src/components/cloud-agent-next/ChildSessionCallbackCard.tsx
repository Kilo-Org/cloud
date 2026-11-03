'use client';

import Link from 'next/link';
import {
  AlertCircle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  GitBranch,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { ChildSessionCallbackPayload } from '@kilocode/worker-utils/cloud-agent-child-callback';
import { cn } from '@/lib/utils';
import { TextPartRenderer } from './part-content';

const STATUS_PRESENTATION = {
  completed: {
    label: 'Completed',
    Icon: CheckCircle2,
    iconClassName: 'text-status-success-icon',
  },
  failed: {
    label: 'Failed',
    Icon: XCircle,
    iconClassName: 'text-status-destructive-icon',
  },
  interrupted: {
    label: 'Interrupted',
    Icon: AlertCircle,
    iconClassName: 'text-status-warning-icon',
  },
} satisfies Record<
  ChildSessionCallbackPayload['status'],
  { label: string; Icon: LucideIcon; iconClassName: string }
>;

export function ChildSessionCallbackCard({ callback }: { callback: ChildSessionCallbackPayload }) {
  const presentation = STATUS_PRESENTATION[callback.status];
  const failureMessage = callback.errorMessage ?? callback.failure?.message;
  const message = callback.result;
  const linkSessionId = callback.kiloSessionId;
  const sessionId = linkSessionId ?? callback.cloudAgentSessionId;
  const sessionHref = linkSessionId
    ? `/cloud/sessions/${encodeURIComponent(linkSessionId)}${callback.messageId ? `?at=${encodeURIComponent(callback.messageId)}` : ''}`
    : null;

  return (
    <div className="border-border bg-card w-full rounded-lg border px-3.5 py-3 text-left text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <Bot className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">Child agent</span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-xs font-normal',
            presentation.iconClassName
          )}
        >
          <presentation.Icon className="size-3.5 shrink-0" aria-hidden="true" />
          {presentation.label}
        </span>
      </div>

      <div className="text-muted-foreground mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="min-w-0 truncate font-mono" title={sessionId}>
          {sessionId}
        </span>
        {callback.branch && (
          <span className="flex min-w-0 items-center gap-1">
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate" title={callback.branch}>
              {callback.branch}
            </span>
          </span>
        )}
      </div>

      {failureMessage && (
        <p className="text-destructive mt-2 text-sm whitespace-pre-wrap wrap-anywhere">
          {failureMessage}
        </p>
      )}

      {message && (
        <div className="mt-2 max-h-80 overflow-y-auto overscroll-contain">
          <TextPartRenderer text={message} />
        </div>
      )}

      {callback.resultTruncated && (
        <p className="text-muted-foreground mt-1 text-xs">Result truncated.</p>
      )}

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {sessionHref && (
          <Link
            href={sessionHref}
            className="text-foreground hover:text-foreground/80 focus-visible:ring-ring inline-flex min-h-6 items-center gap-1 rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
          >
            Open child session
            <ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>
    </div>
  );
}
