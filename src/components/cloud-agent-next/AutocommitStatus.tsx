import { useAtomValue } from 'jotai';
import { Loader2, Check, X } from 'lucide-react';
import type { AutocommitStatus as AutocommitStatusType } from './store/atoms';
import { autocommitStatusMapAtom } from './store/atoms';
import { isAssistantMessage } from './types';
import type { StoredMessage } from './types';

/**
 * Renders autocommit status for an assistant message, if any.
 * Subscribes directly to the autocommit atom so it re-renders independently
 * of memo'd parent components (e.g. StaticMessages).
 */
export function MaybeAutocommitStatus({ msg }: { msg: StoredMessage }) {
  const statusMap = useAtomValue(autocommitStatusMapAtom);
  if (!isAssistantMessage(msg.info)) return null;
  const status = statusMap.get(msg.info.id);
  return status ? <AutocommitStatus status={status} /> : null;
}

export function AutocommitStatus({ status }: { status: AutocommitStatusType }) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="bg-border h-px flex-1" />
      <div className="flex items-center gap-2 text-xs">
        <StatusIndicator status={status} />
      </div>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}

function truncateCommitMessage(message: string, maxLength = 50): string {
  const firstLine = message.split('\n')[0];
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength) + '…';
}

function StatusIndicator({ status }: { status: AutocommitStatusType }) {
  switch (status.status) {
    case 'in_progress':
      return (
        <span className="text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{status.message}</span>
        </span>
      );
    case 'completed':
      return (
        <span className="text-muted-foreground flex items-center gap-2">
          <Check className="h-3 w-3" />
          {status.commitHash ? (
            <span>
              <code className="font-mono">{status.commitHash}</code>{' '}
              {truncateCommitMessage(status.commitMessage ?? status.message)}
            </span>
          ) : (
            <span>{status.message}</span>
          )}
        </span>
      );
    case 'failed':
      return (
        <span className="text-destructive flex items-center gap-2">
          <X className="h-3 w-3" />
          <span>{status.message}</span>
        </span>
      );
  }
}
