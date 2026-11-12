'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

import { PrBadge, PrBadgeSkeleton } from './PrBadge';
import { PrHoverCardContent } from './PrHoverCardContent';
import type { StoredSession } from './types';

type SessionPrIndicatorProps = {
  session: Pick<
    StoredSession,
    'sessionId' | 'branch' | 'associatedPr' | 'repository' | 'worktreeId'
  >;
};

export function SessionPrIndicator({ session }: SessionPrIndicatorProps) {
  if (session.associatedPr === undefined) {
    if (!session.branch) return null;
    return <PrBadgeSkeleton />;
  }

  if (session.associatedPr === null) {
    return null;
  }

  const pr = session.associatedPr;

  return (
    <span className="inline-flex shrink-0" onClick={event => event.stopPropagation()}>
      <Dialog>
        <DialogTrigger asChild>
          <PrBadge pr={pr} title="Open pull request status and maintenance" />
        </DialogTrigger>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Pull request status</DialogTitle>
            <DialogDescription>
              Cached GitHub evidence and automatic maintenance for this workspace.
            </DialogDescription>
          </DialogHeader>
          <PrHoverCardContent
            pr={pr}
            sessionId={session.sessionId}
            gitBranch={session.branch ?? null}
            worktreeId={session.worktreeId}
          />
        </DialogContent>
      </Dialog>
    </span>
  );
}
