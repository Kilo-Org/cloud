import { AlertCircle, Ban, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { type CodeReviewStatus } from '@kilocode/app-shared/code-review';

type CodeReviewStatusIcon = {
  icon: React.ComponentType<{ className?: string }>;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
};

// Icons/badge variant stay web-local; labels come from the shared
// CODE_REVIEW_STATUS_LABELS map so they can't drift from mobile's
// STATUS_META copy.
const statusIconConfig: Record<CodeReviewStatus, CodeReviewStatusIcon> = {
  pending: { icon: Clock, variant: 'secondary' },
  queued: { icon: Clock, variant: 'secondary' },
  running: { icon: Loader2, variant: 'default' },
  completed: { icon: CheckCircle2, variant: 'default' },
  failed: { icon: XCircle, variant: 'destructive' },
  cancelled: { icon: Ban, variant: 'outline' },
  interrupted: { icon: AlertCircle, variant: 'outline' },
};

export function getCodeReviewStatusIcon(status: string): CodeReviewStatusIcon {
  // Object.hasOwn so inherited keys like 'constructor' hit the fallback.
  return Object.hasOwn(statusIconConfig, status)
    ? statusIconConfig[status as CodeReviewStatus]
    : { icon: AlertCircle, variant: 'outline' };
}
