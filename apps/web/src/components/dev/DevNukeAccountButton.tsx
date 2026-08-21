'use client';

import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';
import { nuke } from './actions';

export function DevNukeAccountButton({ kiloUserId: _kiloUserId }: { kiloUserId?: string }) {
  if (process.env.NODE_ENV !== 'development') return null;

  return (
    <Button
      type="button"
      variant="destructive"
      onClick={() => {
        void nuke();
      }}
      data-test-id="nuke-account-button"
      className="w-full"
    >
      <AlertTriangle />
      Reset account
    </Button>
  );
}
