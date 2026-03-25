import { AlertCircle, Check } from 'lucide-react';
import type { SessionStatusIndicator as SessionStatusIndicatorType } from '@/lib/cloud-agent-sdk';
import { StatusSpinner } from './StatusSpinner';

export function SessionStatusIndicator({ indicator }: { indicator: SessionStatusIndicatorType }) {
  return (
    <div className="flex items-center gap-2 py-2 text-xs">
      <IndicatorContent indicator={indicator} />
    </div>
  );
}

function IndicatorContent({ indicator }: { indicator: SessionStatusIndicatorType }) {
  switch (indicator.type) {
    case 'error':
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
