import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

/**
 * The current session failure, attached to the top edge of the composer so it
 * sits beside the send action it blocks. Recovery actions render on the right.
 */
export function SessionErrorNotice({
  message,
  hint,
  actions,
}: {
  message: string;
  hint?: string;
  actions?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="border-status-destructive-border bg-status-destructive-surface mx-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 text-xs"
    >
      <AlertCircle className="text-status-destructive-icon size-3.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 py-1 break-words">
        <span className="text-foreground font-medium">{message}</span>
        {hint && <span className="text-muted-foreground"> {hint}</span>}
      </p>
      {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}
