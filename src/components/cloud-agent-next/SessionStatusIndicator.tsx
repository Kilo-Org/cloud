import type { SessionStatusIndicator as SessionStatusIndicatorType } from '@/lib/cloud-agent-sdk';
import { StatusSpinner } from './StatusSpinner';
import { AlertCircle, Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function SessionStatusIndicator({ indicator }: { indicator: SessionStatusIndicatorType }) {
  return (
    <div className="flex items-center gap-2 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <IndicatorContent indicator={indicator} />
      </div>
    </div>
  );
}

function IndicatorContent({ indicator }: { indicator: SessionStatusIndicatorType }) {
  switch (indicator.type) {
    case 'error':
      if (indicator.stderr) {
        return <ErrorIndicatorWithDetails message={indicator.message} stderr={indicator.stderr} />;
      }

      return (
        <span className="text-destructive flex items-center gap-2">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span>{indicator.message}</span>
        </span>
      );
    case 'warning':
      return (
        <span className="flex items-center gap-2 text-amber-500">
          <StatusSpinner className="h-3 w-3 shrink-0" />
          <span>{indicator.message}</span>
        </span>
      );
    case 'progress':
      return (
        <span className="text-muted-foreground flex items-center gap-2">
          <StatusSpinner className="h-3 w-3 shrink-0" />
          <span>{indicator.message}</span>
        </span>
      );
    case 'info':
      return (
        <span className="text-muted-foreground flex items-center gap-2">
          <Check className="h-3 w-3 shrink-0" />
          <span>{indicator.message}</span>
        </span>
      );
  }
}

function ErrorIndicatorWithDetails({ message, stderr }: { message: string; stderr: string }) {
  return (
    <details className="bg-destructive/5 border-destructive/20 w-full min-w-0 rounded-md border">
      <summary className="text-destructive flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1">{message}</span>
        <span className="text-muted-foreground text-[11px]">Details</span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-3 w-3 shrink-0 transition-transform [[open]>&]:rotate-180'
          )}
        />
      </summary>
      <div className="border-destructive/15 border-t px-3 py-2">
        <pre className="text-foreground max-h-52 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4">
          {stderr}
        </pre>
      </div>
    </details>
  );
}
