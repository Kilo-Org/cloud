'use client';

import { FileText, X } from 'lucide-react';
import { Button as UIButton } from '@/components/ui/button';
import { CopyMessageButton } from '@/components/shared/CopyMessageButton';
import { StatusSpinner } from '@/components/shared/StatusSpinner';

/**
 * Placeholder shown while a chat's real session is being created. It renders
 * the submitted prompt as a user turn plus the creation status, so the user
 * sees their first message immediately instead of a frozen composer. The
 * layout mirrors the transcript (prompt first, status row beneath it, same
 * gutters and row styles) so the handoff to the real chat does not reorder or
 * shift anything.
 */
export function PendingChatView({
  prompt,
  attachmentNames = [],
  statusLabel,
  onDismiss,
}: {
  prompt?: string;
  attachmentNames?: readonly string[];
  statusLabel: string;
  onDismiss?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto px-[max(1rem,calc(50%_-_27rem))] py-2">
      {prompt !== undefined && prompt !== '' && (
        <div className="group/msg flex flex-col items-end py-2" data-message-role="user">
          <div className="bg-primary text-primary-foreground relative max-w-[95%] rounded-md px-3 py-2 sm:max-w-[85%] md:max-w-[80%]">
            <p className="overflow-wrap-anywhere text-sm leading-relaxed wrap-break-word whitespace-pre-wrap">
              {prompt}
            </p>
            {attachmentNames.map((name, index) => (
              <div
                key={`${name}-${index}`}
                className="bg-primary-foreground/10 mt-2 flex items-center gap-2 rounded px-2 py-1.5"
              >
                <FileText className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
              </div>
            ))}
          </div>
          {/* The real bubble's hover row; it also holds the status row's position. */}
          <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100">
            <CopyMessageButton getText={() => prompt} />
          </div>
        </div>
      )}
      <div
        role="status"
        aria-busy="true"
        className="text-muted-foreground flex items-center gap-2 py-2 text-xs"
      >
        <StatusSpinner className="h-3 w-3 shrink-0" />
        <span>{statusLabel}</span>
        {onDismiss && (
          <UIButton
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2"
            onClick={onDismiss}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="sr-only">Dismiss pending chat</span>
          </UIButton>
        )}
      </div>
    </div>
  );
}
