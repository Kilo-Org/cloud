// React must be in scope for the classic JSX runtime used by the jest transform.
import React from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type OrgKiloPassActivationState =
  | 'awaiting_payment'
  | 'activating'
  | 'requires_action'
  | 'blocked'
  | 'failed'
  | 'succeeded'
  | 'ended';

export function OrgKiloPassActivationView({
  state,
  title,
  description,
  actionLabel,
  onAction,
}: {
  state: OrgKiloPassActivationState;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const isLoading = state === 'awaiting_payment' || state === 'activating' || state === 'failed';
  const isSuccess = state === 'succeeded';
  const isBlocked = state === 'blocked' || state === 'requires_action' || state === 'ended';
  const Icon = isLoading && state !== 'failed' ? Loader2 : isSuccess ? CheckCircle2 : AlertTriangle;

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6" aria-busy={isLoading}>
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col items-center p-8 text-center">
          <span
            aria-hidden
            className={cn(
              'mb-5 flex size-12 items-center justify-center rounded-full border',
              isSuccess &&
                'border-status-success-border bg-status-success-surface text-status-success',
              (isBlocked || state === 'failed') &&
                'border-status-warning-border bg-status-warning-surface text-status-warning',
              isLoading &&
                state !== 'failed' &&
                'border-border bg-surface-inset text-muted-foreground'
            )}
          >
            <Icon
              className={cn(
                'size-5',
                isLoading && state !== 'failed' && 'motion-safe:animate-spin'
              )}
            />
          </span>
          <h1 className="type-title" aria-live="polite">
            {title}
          </h1>
          <p className="mt-3 max-w-md type-body text-muted-foreground" aria-live="polite">
            {description}
          </p>
          {isLoading ? (
            <p className="mt-5 type-label text-muted-foreground">
              This usually completes within 30 seconds. You can leave this page safely.
            </p>
          ) : null}
          {actionLabel && onAction ? (
            <Button className="mt-6" onClick={onAction}>
              {actionLabel}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
