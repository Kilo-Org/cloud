'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Info } from 'lucide-react';

type OldSessionBannerProps = {
  onStartNewSession: () => void;
};

export function OldSessionBanner({ onStartNewSession }: OldSessionBannerProps) {
  return (
    <Alert variant="warning" className="mb-4">
      <Info className="h-4 w-4" />
      <AlertTitle>Legacy Session</AlertTitle>
      <AlertDescription>
        <p className="mb-3">
          This is a legacy session displayed in read-only mode. You can start a new session to
          continue working.
        </p>
        <Button size="sm" variant="outline" onClick={onStartNewSession}>
          Start New Session
        </Button>
      </AlertDescription>
    </Alert>
  );
}
