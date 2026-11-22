'use client';

import React from 'react';
import { TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/**
 * Shown while the agent is waiting on a question request this app cannot show,
 * because its payload could not be read or carried no questions. No answer card
 * is offered: a card without questions would present a choice the boundary
 * never parsed. The CLI can still answer the request, so the notice sends the
 * user there instead of letting the run wait invisibly.
 */
export function QuestionUnreadableNotice() {
  return (
    <Alert variant="warning" className="min-w-0">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Question could not be displayed</AlertTitle>
      <AlertDescription className="space-y-1">
        <p>
          The agent is waiting on a question this app cannot show. Answer the question in the CLI to
          continue.
        </p>
      </AlertDescription>
    </Alert>
  );
}
