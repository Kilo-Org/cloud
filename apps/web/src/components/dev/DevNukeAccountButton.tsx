'use client';

import { Button } from '@/components/Button';
import { AlertTriangle } from 'lucide-react';
import { nuke } from './actions';

export function DevNukeAccountButton({ kiloUserId }: { kiloUserId: string }) {
  if (process.env.NODE_ENV !== 'development') return null;

  return (
    <Button
      type="button"
      variant="danger"
      size="md"
      className="flex h-12 w-full max-w-[272px] cursor-pointer items-center justify-center"
      data-test-id="nuke-account-button"
      onClick={() => nuke(kiloUserId)}
    >
      <AlertTriangle className="mx-2 h-5 w-5" />
      Nuke Account
    </Button>
  );
}
