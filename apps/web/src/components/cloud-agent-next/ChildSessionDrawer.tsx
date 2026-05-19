'use client';

import { useCallback, useEffect, useRef, type ComponentProps } from 'react';
import { useAtomValue } from 'jotai';
import { AlertCircle, ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ChildSessionHydrationState } from '@/lib/cloud-agent-sdk';
import { useManager } from './CloudAgentProvider';
import { MessageBubble } from './MessageBubble';
import { MessageErrorBoundary } from './MessageErrorBoundary';
import type { ChildSessionDrawerEntry, OpenChildSession } from './ChildSessionSection';

const IDLE_HYDRATION_STATE: ChildSessionHydrationState = { status: 'idle' };

type ChildSessionDrawerProps = {
  stack: ChildSessionDrawerEntry[];
  onBack: () => void;
  onOpenChange: (open: boolean) => void;
  onOpenChildSession: OpenChildSession;
  onCloseAutoFocus?: ComponentProps<typeof SheetContent>['onCloseAutoFocus'];
  portalContainer?: HTMLElement | null;
};

export function ChildSessionDrawer({
  stack,
  onBack,
  onOpenChange,
  onOpenChildSession,
  onCloseAutoFocus,
  portalContainer,
}: ChildSessionDrawerProps) {
  const manager = useManager();
  const getChildMessages = useAtomValue(manager.atoms.childMessages);
  const getChildSessionHydrationState = useAtomValue(manager.atoms.childSessionHydrationState);
  const selectedEntry = stack[stack.length - 1];
  const selectedSessionId = selectedEntry?.sessionId;
  const messages = selectedSessionId ? getChildMessages(selectedSessionId) : [];
  const hydrationState = selectedSessionId
    ? getChildSessionHydrationState(selectedSessionId)
    : IDLE_HYDRATION_STATE;
  const previousStackDepthRef = useRef(stack.length);
  const backButtonRef = useRef<HTMLButtonElement | null>(null);
  const headingFocusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedSessionId) return;
    void manager.hydrateChildSession(selectedSessionId);
  }, [manager, selectedSessionId]);

  useEffect(() => {
    const previousStackDepth = previousStackDepthRef.current;
    previousStackDepthRef.current = stack.length;

    if (stack.length === 0 || previousStackDepth === stack.length) {
      return;
    }

    if (stack.length > 1) {
      backButtonRef.current?.focus();
      return;
    }

    headingFocusRef.current?.focus();
  }, [stack.length]);

  const handleRetry = useCallback(() => {
    if (!selectedSessionId) return;
    void manager.hydrateChildSession(selectedSessionId);
  }, [manager, selectedSessionId]);

  const hasMessages = messages.length > 0;

  return (
    <Sheet modal={false} open={stack.length > 0} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        portalContainer={portalContainer}
        overlayClassName="absolute"
        dismissibleOverlay
        className="absolute inset-y-0 right-0 h-full w-full gap-0 border-l p-0 sm:max-w-xl lg:max-w-2xl"
        onCloseAutoFocus={onCloseAutoFocus}
        onInteractOutside={event => event.preventDefault()}
      >
        <SheetHeader className="shrink-0 border-b pr-14">
          <div className="flex min-w-0 items-start gap-2">
            {stack.length > 1 && (
              <Button
                ref={backButtonRef}
                variant="ghost"
                size="sm"
                onClick={onBack}
                className="shrink-0 gap-1 px-2"
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
            )}
            <div
              ref={headingFocusRef}
              tabIndex={-1}
              className="focus-visible:ring-ring/50 min-w-0 space-y-1 rounded-sm focus-visible:ring-[3px] focus-visible:outline-none"
            >
              <SheetTitle className="truncate text-base">
                {selectedEntry?.description || 'Sub-agent transcript'}
              </SheetTitle>
              <SheetDescription className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {selectedEntry?.agent ? `Agent: ${selectedEntry.agent}` : 'Sub-agent session'}
                </span>
                {selectedSessionId && (
                  <span className="truncate font-mono text-xs">{selectedSessionId}</span>
                )}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {hydrationState.status === 'loading' && (
            <div className="border-border bg-muted/20 text-muted-foreground mb-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span>
                {hasMessages
                  ? 'Loading earlier sub-agent messages...'
                  : 'Loading sub-agent messages...'}
              </span>
            </div>
          )}

          {hydrationState.status === 'error' && (
            <div className="border-destructive/40 bg-destructive/10 mb-4 rounded-lg border px-3 py-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium">Could not load sub-agent history.</p>
                  <p className="text-muted-foreground text-sm">{hydrationState.message}</p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={handleRetry} className="mt-3 gap-1.5">
                <RefreshCw className="size-3.5" />
                Retry history load
              </Button>
            </div>
          )}

          {hasMessages ? (
            <div>
              {messages.map(message => (
                <MessageErrorBoundary key={message.info.id}>
                  <MessageBubble
                    message={message}
                    getChildMessages={getChildMessages}
                    onOpenChildSession={onOpenChildSession}
                  />
                </MessageErrorBoundary>
              ))}
            </div>
          ) : hydrationState.status === 'loading' || hydrationState.status === 'error' ? null : (
            <div className="border-border bg-muted/20 text-muted-foreground rounded-lg border px-4 py-6 text-sm">
              No sub-agent messages yet.
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
