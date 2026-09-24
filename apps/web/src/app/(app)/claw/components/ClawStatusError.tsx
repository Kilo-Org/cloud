import * as React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'An unexpected error occurred';
}

/**
 * Retryable error state for the KiloClaw status read
 * (`kiloclaw.getStatus` / `organizations.kiloclaw.getStatus`).
 *
 * A status read only fails through a transient condition — the worker is
 * unreachable, the read timed out, or the request was interrupted — so the
 * state always offers a retry action. The non-transient outcomes are handled
 * before this point: no instance redirects to setup, and a billing/access lock
 * renders its own gate. Without this the user lands on a dead-end error with
 * nothing to do but reload the whole page.
 */
export function ClawStatusError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertCircle className="text-destructive h-4 w-4 shrink-0" />
          Could not load KiloClaw instances
        </CardTitle>
        <CardDescription>
          The instance status could not be read. This is usually temporary — try again in a moment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-destructive text-sm">{formatError(error)}</p>
        <Button onClick={onRetry} variant="outline" size="sm" className="mt-4 gap-2">
          <RefreshCw className="h-4 w-4" />
          Try Again
        </Button>
      </CardContent>
    </Card>
  );
}
