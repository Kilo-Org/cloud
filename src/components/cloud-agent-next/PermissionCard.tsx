'use client';

import { useState, useCallback, createContext, useContext, useMemo, type ReactNode } from 'react';

import { Shield, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';

// ---------------------------------------------------------------------------
// PermissionContext — mirrors QuestionContext pattern
// ---------------------------------------------------------------------------

type PermissionContextValue = {
  cloudAgentSessionId: string | null;
  organizationId: string | null;
  /** When set, PermissionCard routes through the session manager instead of tRPC. */
  respondToPermission?: (
    requestId: string,
    response: 'once' | 'always' | 'reject'
  ) => Promise<void>;
};

const PermissionContext = createContext<PermissionContextValue>({
  cloudAgentSessionId: null,
  organizationId: null,
});

function usePermissionContext(): PermissionContextValue {
  return useContext(PermissionContext);
}

type PermissionContextProviderProps = PermissionContextValue & {
  children: ReactNode;
};

export function PermissionContextProvider({
  cloudAgentSessionId,
  organizationId,
  respondToPermission,
  children,
}: PermissionContextProviderProps) {
  const value = useMemo(
    () => ({ cloudAgentSessionId, organizationId, respondToPermission }),
    [cloudAgentSessionId, organizationId, respondToPermission]
  );
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

// ---------------------------------------------------------------------------
// PermissionCard
// ---------------------------------------------------------------------------

type PermissionCardProps = {
  requestId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
};

type PermissionResponse = 'once' | 'always' | 'reject';

export function PermissionCard({
  requestId,
  permission,
  patterns,
  metadata,
  always,
}: PermissionCardProps) {
  const [pending, setPending] = useState<PermissionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trpcClient = useRawTRPCClient();
  const {
    cloudAgentSessionId: sessionId,
    organizationId,
    respondToPermission,
  } = usePermissionContext();

  const respond = useCallback(
    async (response: PermissionResponse) => {
      if (pending) return;

      setPending(response);
      setError(null);

      try {
        if (respondToPermission) {
          await respondToPermission(requestId, response);
        } else {
          if (!sessionId) return;
          if (organizationId) {
            await trpcClient.organizations.cloudAgentNext.answerPermission.mutate(
              { organizationId, sessionId, permissionId: requestId, response },
              { context: { skipBatch: true } }
            );
          } else {
            await trpcClient.cloudAgentNext.answerPermission.mutate(
              { sessionId, permissionId: requestId, response },
              { context: { skipBatch: true } }
            );
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to respond to permission');
        setPending(null);
      }
    },
    [sessionId, organizationId, requestId, pending, trpcClient, respondToPermission]
  );

  const isAlreadyAllowed = always.includes(permission);

  // Extract command from metadata if present
  const command = typeof metadata.command === 'string' ? metadata.command : null;

  return (
    <div className="bg-muted/30 w-full max-w-lg rounded-md border border-l-4 border-amber-500/40">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Shield className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="text-sm font-medium capitalize">{permission}</span>
        <span className="text-muted-foreground text-xs">permission request</span>
      </div>

      <div className="border-muted space-y-3 border-t px-3 py-2">
        {/* File patterns */}
        {patterns.length > 0 && (
          <div>
            <div className="text-muted-foreground mb-1 text-xs font-medium">Patterns</div>
            <div className="flex flex-wrap gap-1">
              {patterns.map((pattern, idx) => (
                <code key={idx} className="bg-muted rounded px-1.5 py-0.5 text-xs">
                  {pattern}
                </code>
              ))}
            </div>
          </div>
        )}

        {/* Command (from metadata) */}
        {command && (
          <div>
            <div className="text-muted-foreground mb-1 text-xs font-medium">Command</div>
            <pre className="bg-muted overflow-x-auto rounded px-2 py-1 text-xs">
              <code>{command}</code>
            </pre>
          </div>
        )}

        {/* Already allowed hint */}
        {isAlreadyAllowed && (
          <div className="text-muted-foreground text-xs italic">
            &quot;{permission}&quot; is already in the always-allow list.
          </div>
        )}

        {/* Error */}
        {error && <div className="text-xs text-red-500">{error}</div>}

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => respond('once')}
            disabled={pending !== null}
            className={cn(
              'gap-1.5',
              pending !== 'once' &&
                'bg-green-600 text-white hover:bg-green-700 focus:ring-green-500'
            )}
          >
            {pending === 'once' && <Loader2 className="h-3 w-3 animate-spin" />}
            Allow Once
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => respond('always')}
            disabled={pending !== null}
            className="gap-1.5"
          >
            {pending === 'always' && <Loader2 className="h-3 w-3 animate-spin" />}
            Always Allow
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => respond('reject')}
            disabled={pending !== null}
            className="gap-1.5"
          >
            {pending === 'reject' && <Loader2 className="h-3 w-3 animate-spin" />}
            Deny
          </Button>
        </div>
      </div>
    </div>
  );
}
