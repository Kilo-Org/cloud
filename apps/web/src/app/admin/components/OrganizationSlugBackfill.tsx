'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useTRPC } from '@/lib/trpc/utils';

type BatchLog = {
  updatedCount: number;
  timestamp: Date;
};

export function OrganizationSlugBackfill() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [logs, setLogs] = useState<BatchLog[]>([]);

  const mutation = useMutation(
    trpc.organizations.admin.backfillMissingSlugs.mutationOptions({
      onSuccess: data => {
        setLogs(prev => [{ updatedCount: data.updatedCount, timestamp: new Date() }, ...prev]);
        void queryClient.invalidateQueries({ queryKey: ['admin-organizations'] });
      },
    })
  );

  const lastResult = mutation.data;
  const isDone = lastResult?.updatedCount === 0;

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Backfill organization slugs for legacy organizations missing the field. This scans all
        missing rows in one transaction and allocates unique slugs from organization names.
      </p>

      <div className="bg-background space-y-4 rounded-lg border p-6">
        <div className="flex items-center gap-3">
          <span className="font-medium">Organizations missing slugs</span>
          {lastResult ? (
            isDone ? (
              <Badge variant="default" className="bg-green-600">
                None updated
              </Badge>
            ) : (
              <Badge variant="secondary">{lastResult.updatedCount.toLocaleString()} updated</Badge>
            )
          ) : (
            <Badge variant="secondary">Not checked</Badge>
          )}
        </div>

        {mutation.isError && (
          <Alert variant="destructive">
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        )}

        {lastResult && lastResult.organizations.length > 0 ? (
          <div className="bg-surface-inset max-h-56 overflow-auto rounded-md border p-3 font-mono text-xs">
            <div className="space-y-1">
              {lastResult.organizations.map(organization => (
                <div
                  key={organization.id}
                  className="text-muted-foreground grid grid-cols-[minmax(0,1fr)_auto] gap-3"
                >
                  <span className="truncate">{organization.name}</span>
                  <span className="text-foreground">{organization.slug}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? 'Backfilling...' : 'Backfill missing slugs'}
        </Button>
      </div>

      {logs.length > 0 && (
        <div className="bg-background space-y-2 rounded-lg border p-4">
          <h4 className="text-sm font-medium">Batch log</h4>
          <div className="space-y-1 font-mono text-xs">
            {logs.map((log, i) => (
              <div key={i} className="text-muted-foreground flex gap-2">
                <span className="shrink-0">{log.timestamp.toLocaleTimeString()}</span>
                <span>backfilled {log.updatedCount.toLocaleString()} organizations</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
