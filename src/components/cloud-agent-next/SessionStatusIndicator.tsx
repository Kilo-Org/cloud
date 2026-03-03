import { AlertCircle, Loader2, Check } from 'lucide-react';
import type { SessionStatusIndicator as SessionStatusIndicatorType } from './store/atoms';

export function SessionStatusIndicator({ indicator }: { indicator: SessionStatusIndicatorType }) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="bg-border h-px flex-1" />
      <div className="flex items-center gap-2 text-xs">
        <IndicatorContent indicator={indicator} />
      </div>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}

function IndicatorContent({ indicator }: { indicator: SessionStatusIndicatorType }) {
  switch (indicator.type) {
    case 'error':
      return (
        <span className="text-destructive flex items-center gap-2">
          <AlertCircle className="h-3 w-3" />
          <span>{indicator.message}</span>
        </span>
      );
    case 'warning':
      return (
        <span className="flex items-center gap-2 text-amber-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{indicator.message}</span>
        </span>
      );
    case 'info':
      return (
        <span className="text-muted-foreground flex items-center gap-2">
          <Check className="h-3 w-3" />
          <span>{indicator.message}</span>
        </span>
      );
  }
}
