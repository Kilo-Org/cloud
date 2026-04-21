'use client';

import { useState, useCallback, createContext, useContext, useMemo, type ReactNode } from 'react';

import { Sparkles, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { SuggestionAction } from '@/lib/cloud-agent-sdk';

// ---------------------------------------------------------------------------
// SuggestionContext — mirrors PermissionContext pattern
// ---------------------------------------------------------------------------

type SuggestionContextValue = {
  /** When set, SuggestionCard routes through the session manager. */
  acceptSuggestion?: (requestId: string, index: number) => Promise<void>;
  dismissSuggestion?: (requestId: string) => Promise<void>;
};

const SuggestionContext = createContext<SuggestionContextValue>({});

function useSuggestionContext(): SuggestionContextValue {
  return useContext(SuggestionContext);
}

type SuggestionContextProviderProps = SuggestionContextValue & {
  children: ReactNode;
};

export function SuggestionContextProvider({
  acceptSuggestion,
  dismissSuggestion,
  children,
}: SuggestionContextProviderProps) {
  const value = useMemo(
    () => ({ acceptSuggestion, dismissSuggestion }),
    [acceptSuggestion, dismissSuggestion]
  );
  return <SuggestionContext.Provider value={value}>{children}</SuggestionContext.Provider>;
}

// ---------------------------------------------------------------------------
// SuggestionCard
// ---------------------------------------------------------------------------

type SuggestionCardProps = {
  requestId: string;
  text: string;
  actions: SuggestionAction[];
};

type PendingState = { kind: 'accept'; index: number } | { kind: 'dismiss' };

export function SuggestionCard({ requestId, text, actions }: SuggestionCardProps) {
  const [pending, setPending] = useState<PendingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { acceptSuggestion, dismissSuggestion } = useSuggestionContext();

  const onAccept = useCallback(
    async (index: number) => {
      if (pending) return;
      if (!acceptSuggestion) {
        console.warn(
          'SuggestionCard: no acceptSuggestion handler in context — wrap the card in <SuggestionContextProvider>.'
        );
        setError('Suggestion handler not configured');
        return;
      }
      setPending({ kind: 'accept', index });
      setError(null);
      try {
        await acceptSuggestion(requestId, index);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to accept suggestion');
        setPending(null);
      }
    },
    [pending, acceptSuggestion, requestId]
  );

  const onDismiss = useCallback(async () => {
    if (pending) return;
    if (!dismissSuggestion) {
      console.warn(
        'SuggestionCard: no dismissSuggestion handler in context — wrap the card in <SuggestionContextProvider>.'
      );
      setError('Suggestion handler not configured');
      return;
    }
    setPending({ kind: 'dismiss' });
    setError(null);
    try {
      await dismissSuggestion(requestId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss suggestion');
      setPending(null);
    }
  }, [pending, dismissSuggestion, requestId]);

  return (
    <div className="bg-muted/30 w-full rounded-md border border-l-4 border-blue-500/40">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Sparkles className="h-4 w-4 shrink-0 text-blue-500" />
        <span className="text-sm font-medium">Suggestion</span>
      </div>

      <div className="border-muted space-y-3 border-t px-3 py-2">
        <div className="text-sm">{text}</div>

        {error && <div className="text-xs text-red-500">{error}</div>}

        {/* Action buttons — one per suggested action, plus a Dismiss */}
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((action, index) => {
            const isPending = pending?.kind === 'accept' && pending.index === index;
            return (
              <Button
                key={`${action.label}-${index}`}
                size="sm"
                onClick={() => {
                  void onAccept(index);
                }}
                disabled={pending !== null}
                title={action.description}
                className={cn(
                  'gap-1.5',
                  !isPending && 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500'
                )}
              >
                {isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                {action.label}
              </Button>
            );
          })}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void onDismiss();
            }}
            disabled={pending !== null}
            className="gap-1.5"
          >
            {pending?.kind === 'dismiss' && <Loader2 className="h-3 w-3 animate-spin" />}
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
