import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { formatSnapshotTime } from './snapshot-display';

export function ChatWakeup({
  sessionId,
  organizationId,
  readOnly,
}: {
  sessionId: string;
  organizationId?: string;
  readOnly: boolean;
}) {
  const trpc = useTRPC();
  const client = useRawTRPCClient();
  const queryClient = useQueryClient();
  const query = organizationId
    ? trpc.organizations.cloudAgentNext.getWakeup.queryOptions({ sessionId, organizationId })
    : trpc.cloudAgentNext.getWakeup.queryOptions({ sessionId });
  const { data: wakeup } = useQuery({ ...query, refetchInterval: 5_000, retry: false });
  const { data: sandbox } = useQuery({
    ...(organizationId
      ? trpc.organizations.cloudAgentNext.getSandboxStatus.queryOptions({
          cloudAgentSessionId: sessionId,
          organizationId,
        })
      : trpc.cloudAgentNext.getSandboxStatus.queryOptions({ cloudAgentSessionId: sessionId })),
    enabled: wakeup?.state === 'pending' && wakeup.mode === 'sleep',
    refetchInterval: 5_000,
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const result = organizationId
        ? await client.organizations.cloudAgentNext.cancelWakeup.mutate({
            sessionId,
            organizationId,
            id,
          })
        : await client.cloudAgentNext.cancelWakeup.mutate({ sessionId, id });
      if (!result.ok) throw new Error(result.error);
      return result.wakeup;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: query.queryKey }),
  });
  if (wakeup?.state !== 'pending' && wakeup?.state !== 'failed') return null;
  return (
    <div className="bg-muted mx-auto mb-2 flex max-w-[54rem] items-start justify-between gap-3 rounded-md px-3 py-2 text-xs">
      <div className="min-w-0 space-y-1">
        {wakeup.state === 'failed' ? (
          <p>Wakeup failed. {wakeup.failure}</p>
        ) : (
          <>
            <p className="font-medium">
              Wakeup at{' '}
              <time dateTime={new Date(wakeup.dueAt).toISOString()}>
                {formatSnapshotTime(wakeup.dueAt)}
              </time>
              {' · '}
              {wakeup.mode === 'sleep' ? 'Sleep mode' : 'Stay awake'}
            </p>
            <p className="text-muted-foreground wrap-break-word whitespace-pre-wrap">
              {wakeup.prompt}
            </p>
            {wakeup.mode === 'sleep' && (
              <p className="text-muted-foreground">
                {sandbox?.status === 'sleeping' && sandbox.runtime?.stoppedAt != null
                  ? 'Sleeping'
                  : 'Early stop needs an idle workspace and a fresh snapshot.'}
              </p>
            )}
          </>
        )}
        {cancel.error && (
          <p role="alert" className="text-destructive">
            {cancel.error.message}
          </p>
        )}
      </div>
      {wakeup.state === 'pending' && !readOnly && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(wakeup.id)}
        >
          Cancel wakeup
        </Button>
      )}
    </div>
  );
}
