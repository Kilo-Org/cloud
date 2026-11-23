import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { z } from 'zod';

import { useTRPC } from '@/lib/trpc';

/**
 * The saved-file list and the sandbox snapshot behind one session's artifacts
 * sheet.
 *
 * Each read goes to the personal procedure or the organization one, and its
 * query key is the tRPC procedure path with its input, so it cannot collide
 * with the web panel's own keys (`workspace-artifacts`,
 * `workspace-artifacts-sandbox-status`). The list is refetched whenever the
 * sheet opens: the worker writes a file while a turn runs, so a list read once
 * would go stale behind the session it describes.
 */
export function useSessionArtifacts({
  cloudAgentSessionId,
  organizationId,
  enabled,
}: {
  cloudAgentSessionId: string;
  organizationId: string | undefined;
  /** The sheet is open. Each query stays idle while it is closed. */
  enabled: boolean;
}) {
  const trpc = useTRPC();
  // A read that ran out of time, was throttled or hit a failing server can
  // succeed on its own; any other refusal repeats, so only those are retried.
  // A failure with no HTTP status (a transport error) is treated as transient,
  // because the app already retries a request that never reached the server.
  const retry = (failureCount: number, error: unknown) => {
    const status = readHttpStatus(error);
    return (
      failureCount < 2 &&
      (status === undefined || status === 408 || status === 429 || status >= 500)
    );
  };
  const options = { enabled, staleTime: 0, refetchOnMount: 'always' as const, retry };

  const list = useQuery(
    organizationId === undefined
      ? trpc.cloudAgentNext.listWorkspaceArtifacts.queryOptions({ cloudAgentSessionId }, options)
      : trpc.organizations.cloudAgentNext.listWorkspaceArtifacts.queryOptions(
          { cloudAgentSessionId, organizationId },
          options
        )
  );
  const sandboxStatus = useQuery(
    organizationId === undefined
      ? trpc.cloudAgentNext.getSandboxStatus.queryOptions({ cloudAgentSessionId }, options)
      : trpc.organizations.cloudAgentNext.getSandboxStatus.queryOptions(
          { cloudAgentSessionId, organizationId },
          options
        )
  );

  const listRefetch = list.refetch;
  const sandboxRefetch = sandboxStatus.refetch;
  const refetch = useCallback(() => {
    void listRefetch();
    void sandboxRefetch();
  }, [listRefetch, sandboxRefetch]);

  return { list, sandboxStatus, refetch };
}

const HttpStatusEnvelope = z.looseObject({
  data: z.looseObject({ httpStatus: z.number().optional() }).optional(),
  shape: z
    .looseObject({ data: z.looseObject({ httpStatus: z.number().optional() }).optional() })
    .optional(),
});

/** The HTTP status a refused tRPC read carries, from either error envelope. */
function readHttpStatus(error: unknown): number | undefined {
  const parsed = HttpStatusEnvelope.safeParse(error);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.data?.httpStatus ?? parsed.data.shape?.data?.httpStatus;
}
