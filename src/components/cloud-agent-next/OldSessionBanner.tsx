'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Info } from 'lucide-react';

type OldSessionBannerProps = {
  onStartNewSession: () => void;
};

/**
 * OldSessionBanner - Warning banner for V1 legacy sessions.
 *
 * Displays a yellow/amber warning banner indicating that the session
 * uses an older format that is no longer supported, with a button
 * to start a new session.
 */
export function OldSessionBanner({ onStartNewSession }: OldSessionBannerProps) {
  return (
    <Alert variant="warning" className="mb-4">
      <Info className="h-4 w-4" />
      <AlertTitle>Legacy Session</AlertTitle>
      <AlertDescription>
        <p className="mb-3">This session uses an older format that is no longer supported.</p>
        <Button size="sm" variant="outline" onClick={onStartNewSession}>
          Start New Session
        </Button>
      </AlertDescription>
    </Alert>
  );
}
