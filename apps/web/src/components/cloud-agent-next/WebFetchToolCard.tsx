import { Globe, Loader2, XCircle } from 'lucide-react';
import { toSafeHttpUrl } from '@/lib/safe-http-url';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';

type WebFetchToolCardProps = {
  toolPart: ToolPart;
};

export function WebFetchToolCard({ toolPart }: WebFetchToolCardProps) {
  const state = toolPart.state;
  const url = typeof state.input.url === 'string' ? state.input.url.trim() : '';
  const href = toSafeHttpUrl(url);
  const isLoading = state.status === 'pending' || state.status === 'running';
  const statusLabel = {
    pending: 'Pending',
    running: 'Fetching',
    completed: 'Completed',
    error: 'Failed',
  }[state.status];

  return (
    <div
      data-tool-card
      className={cn(
        'text-muted-foreground flex min-h-6 min-w-0 items-center gap-2 px-2 py-1 text-xs',
        state.status === 'error' && 'text-destructive'
      )}
    >
      {isLoading ? (
        <Loader2
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : state.status === 'error' ? (
        <XCircle className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Globe className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="shrink-0">WebFetch</span>
      <span aria-hidden="true" className="text-muted-foreground/60">
        ·
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={url}
          className="hover:text-foreground focus-visible:ring-ring min-w-0 truncate rounded-sm font-mono hover:underline focus-visible:ring-2 focus-visible:outline-none pointer-coarse:min-h-11 pointer-coarse:content-center"
        >
          {url}
        </a>
      ) : (
        <span title={url} className="min-w-0 truncate font-mono">
          {url || 'URL unavailable'}
        </span>
      )}
      <span className="ml-auto shrink-0">{statusLabel}</span>
    </div>
  );
}
