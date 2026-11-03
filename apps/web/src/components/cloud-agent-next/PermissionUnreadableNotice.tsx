'use client';

import React from 'react';
import { TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * Shown while the agent is waiting on a permission request this app cannot
 * read. No consent card is offered, because a card would describe a scope the
 * boundary never parsed; the CLI can still answer the request, so the notice
 * sends the user there instead of letting the run wait invisibly.
 */
export function PermissionUnreadableNotice() {
  return (
    <Alert variant="warning" className="min-w-0">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Permission request could not be read</AlertTitle>
      <AlertDescription className="space-y-1">
        <p>
          The agent is waiting for a permission decision this app cannot show. Update the app or the
          CLI, or answer the request in the CLI to continue.
        </p>
      </AlertDescription>
    </Alert>
  );
}
