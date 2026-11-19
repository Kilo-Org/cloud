'use client';

import { useEffect } from 'react';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const OUTCOME_ICON_BACKGROUND = {
  success: 'bg-green-100 dark:bg-green-900',
  pending: 'bg-amber-100 dark:bg-amber-900',
  failure: 'bg-red-100 dark:bg-red-900',
} as const;

type ShellOutcomeProps = {
  kind: 'success' | 'pending' | 'failure';
  title: string;
  description: string;
};

/**
 * The end of every shell flow: the in-app browser opened this page, so it can
 * close itself the way the device-auth page does, and the user lands back in
 * the Kilo App. The button is the fallback for browsers that ignore
 * `window.close()` on a tab they did not open with script.
 */
export function ShellOutcome({ kind, title, description }: ShellOutcomeProps) {
  useEffect(() => {
    window.close();
  }, []);

  return (
    <Card>
      <CardHeader className="text-center">
        <div
          className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full ${OUTCOME_ICON_BACKGROUND[kind]}`}
        >
          {kind === 'success' ? (
            <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-400" />
          ) : kind === 'pending' ? (
            <RefreshCw className="h-10 w-10 text-amber-600 dark:text-amber-400" />
          ) : (
            <XCircle className="h-10 w-10 text-red-600 dark:text-red-400" />
          )}
        </div>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-2">
        <Button variant="outline" onClick={() => window.close()}>
          Return to the Kilo App
        </Button>
        <p className="text-muted-foreground text-sm">You can close this window</p>
      </CardContent>
    </Card>
  );
}
