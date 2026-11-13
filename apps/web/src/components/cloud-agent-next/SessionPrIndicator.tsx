'use client';

import { useEffect, useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

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
  const [mode, setMode] = useState<'preview' | 'pinned' | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreFocus = useRef(false);
  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }
  function scheduleClose() {
    cancelClose();
    closeTimer.current = setTimeout(
      () => setMode(current => (current === 'preview' ? null : current)),
      150
    );
  }
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    []
  );
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
      <Popover
        open={mode !== null}
        onOpenChange={open => {
          cancelClose();
          if (open) restoreFocus.current = true;
          setMode(open ? 'pinned' : null);
        }}
      >
        <PopoverTrigger asChild>
          <PrBadge
            pr={pr}
            title="Pull request status"
            onPointerEnter={event => {
              if (event.pointerType !== 'mouse') return;
              cancelClose();
              if (mode === null) restoreFocus.current = false;
              setMode(current => current ?? 'preview');
            }}
            onPointerLeave={scheduleClose}
            onClick={event => {
              event.preventDefault();
              cancelClose();
              restoreFocus.current = true;
              setMode(current => (current === 'pinned' ? null : 'pinned'));
            }}
          />
        </PopoverTrigger>
        <PopoverContent
          aria-label="Pull request status"
          align="end"
          className="w-80 max-w-[calc(100vw-2rem)] max-h-[min(36rem,85dvh)] overflow-y-auto"
          onOpenAutoFocus={event => {
            if (mode === 'preview') event.preventDefault();
          }}
          onCloseAutoFocus={event => {
            if (!restoreFocus.current) event.preventDefault();
          }}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
          onPointerDownCapture={() => {
            cancelClose();
            restoreFocus.current = true;
            setMode('pinned');
          }}
          onFocusCapture={() => {
            restoreFocus.current = true;
            setMode('pinned');
          }}
        >
          <PrHoverCardContent
            pr={pr}
            sessionId={session.sessionId}
            gitBranch={session.branch ?? null}
            worktreeId={session.worktreeId}
          />
        </PopoverContent>
      </Popover>
    </span>
  );
}
