'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  readToolDetailMarker,
  type ToolDetailMarker,
} from '@kilocode/cloud-agent-sdk/tool-part-detail';
import { Button } from '@/components/ui/button';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import {
  deriveToolDetailView,
  isTerminalToolDetailError,
  removeToolDetailQueries,
  shouldRetryToolDetail,
  toolDetailQueryKey,
  type ToolDetailScope,
  type ToolDetailState,
} from './tool-part-detail-state';
import type { ToolPart } from './types';

const ToolDetailScopeContext = createContext<ToolDetailScope | null>(null);

/** Authorizes nothing: it only names the account and workspace session a detail read asks for. */
export function ToolDetailScopeProvider({
  scope,
  children,
}: {
  scope: ToolDetailScope | null;
  children: ReactNode;
}) {
  return <ToolDetailScopeContext value={scope}>{children}</ToolDetailScopeContext>;
}

type ToolDetailContextValue = {
  marker: ToolDetailMarker;
  state: ToolDetailState;
  request: () => void;
  retry: () => void;
};

const ToolDetailContext = createContext<ToolDetailContextValue | null>(null);

/** The preview state of the enclosing tool part, or `null` for complete data. */
export function useToolDetail(): ToolDetailContextValue | null {
  return useContext(ToolDetailContext);
}

/**
 * Renders a tool part, replacing a bounded preview with its complete stored
 * call once the card is expanded. Closed previews never fetch.
 */
export function ToolPartDetailBoundary({
  part,
  children,
}: {
  part: ToolPart;
  children: (part: ToolPart) => ReactNode;
}) {
  const marker = useMemo(() => readToolDetailMarker(part), [part]);
  if (marker === undefined) return children(part);
  return (
    <PreviewToolPart preview={part} marker={marker}>
      {children}
    </PreviewToolPart>
  );
}

function PreviewToolPart({
  preview,
  marker,
  children,
}: {
  preview: ToolPart;
  marker: ToolDetailMarker;
  children: (part: ToolPart) => ReactNode;
}) {
  const scope = useContext(ToolDetailScopeContext);
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [requested, setRequested] = useState(false);
  const enabled = requested && scope !== null;
  const query = useQuery({
    queryKey: scope
      ? toolDetailQueryKey(scope, preview, marker.revision)
      : ['cloud-agent-tool-detail', 'unscoped'],
    queryFn: async () => {
      if (!scope) throw new Error('Tool detail scope is missing');
      const input = {
        sessionId: scope.cloudAgentSessionId,
        kiloSessionId: preview.sessionID,
        messageId: preview.messageID,
        partId: preview.id,
        callId: preview.callID,
      };
      try {
        return scope.organizationId
          ? await trpcClient.organizations.cloudAgentNext.getSessionToolPartDetail.query({
              ...input,
              organizationId: scope.organizationId,
            })
          : await trpcClient.cloudAgentNext.getSessionToolPartDetail.query(input);
      } catch (error) {
        // A denied or missing session retires every detail fetched for it.
        if (isTerminalToolDetailError(error))
          removeToolDetailQueries(queryClient, preview.sessionID, 'inactive');
        throw error;
      }
    },
    enabled,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: shouldRetryToolDetail,
  });
  const scoped = scope !== null;
  const { status, data, error } = query;
  const view = useMemo(
    () =>
      deriveToolDetailView({
        preview,
        revision: marker.revision,
        requested,
        scoped,
        query: { status, data, error },
      }),
    [preview, marker.revision, requested, scoped, status, data, error]
  );
  const request = useCallback(() => setRequested(true), []);
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const value = useMemo(
    () => ({ marker, state: view.state, request, retry }),
    [marker, view.state, request, retry]
  );
  return <ToolDetailContext value={value}>{children(view.part)}</ToolDetailContext>;
}

/** Shown inside an expanded preview until its complete call is available. */
export function ToolDetailNotice() {
  const detail = useToolDetail();
  if (!detail) return null;
  const { state } = detail;
  if (state.status === 'complete' || state.status === 'idle') return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="text-muted-foreground flex min-h-6 flex-wrap items-center gap-2 text-xs"
    >
      {state.status === 'loading' ? (
        <>
          <Loader2
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span>Showing a preview. Loading the full output…</span>
        </>
      ) : (
        <span>{state.message}</span>
      )}
      {state.status === 'error' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs pointer-coarse:h-11"
          onClick={detail.retry}
        >
          Retry
        </Button>
      )}
    </div>
  );
}
