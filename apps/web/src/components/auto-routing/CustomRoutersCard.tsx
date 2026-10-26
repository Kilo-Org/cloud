'use client';

import type {
  CustomRouterListResponse,
  OwnerType,
  CustomRouterSummary,
} from '@kilocode/auto-routing-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Workflow } from 'lucide-react';
import React, { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { CustomRouterDialog } from './CustomRouterDialog';
import {
  BASE_ROUTER_OPTIONS,
  CUSTOM_ROUTERS_POLL_INTERVAL_MS,
  MODE_OPTIONS,
  deleteCustomRouter,
  entryDisplayStatus,
  entryLabel,
  fetchCustomRouters,
  hasPendingEntries,
} from './custom-router-display';

type Props = {
  organizationId?: string;
  readonly?: boolean;
};

type EditorState = { router: CustomRouterSummary | undefined } | null;

export function customRoutersQueryKey(organizationId: string | undefined) {
  return ['auto-routing-custom-routers', organizationId ?? 'personal'] as const;
}

export function CustomRoutersCard({ organizationId, readonly = false }: Props) {
  const queryClient = useQueryClient();
  const queryKey = customRoutersQueryKey(organizationId);
  const scope: OwnerType = organizationId ? 'org' : 'user';
  const [editor, setEditor] = useState<EditorState>(null);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchCustomRouters(organizationId),
    refetchInterval: current =>
      current.state.data &&
      hasPendingEntries(current.state.data.routers.filter(router => router.scope === scope))
        ? CUSTOM_ROUTERS_POLL_INTERVAL_MS
        : false,
  });

  const deleteMutation = useMutation({
    mutationFn: (router: CustomRouterSummary) => deleteCustomRouter(router, organizationId),
    onSuccess: (_result, router) => {
      queryClient.setQueryData<CustomRouterListResponse | null>(queryKey, current =>
        current ? { routers: current.routers.filter(item => item.id !== router.id) } : current
      );
      toast.success(`Deleted ${router.name}`);
    },
    onError: error => toast.error(error.message),
  });

  if (query.data === null) return null;

  const routers = (query.data?.routers ?? []).filter(router => router.scope === scope);
  const canCreate = !readonly && query.data?.canCreate !== false;

  const header = (
    <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1.5">
        <CardTitle className="flex items-center gap-2">
          <Workflow className="size-5" aria-hidden />
          Custom routers
        </CardTitle>
        <CardDescription>
          Route each request to the best model in a pool you choose. Use the router&apos;s model ID
          like any other model.
        </CardDescription>
      </div>
      {canCreate && query.data ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setEditor({ router: undefined })}
        >
          <Plus className="size-4" aria-hidden />
          Create router
        </Button>
      ) : null}
    </CardHeader>
  );

  if (query.isLoading) {
    return (
      <Card className="w-full">
        {header}
        <CardContent className="space-y-3" aria-busy="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (query.isError && query.data === undefined) {
    return (
      <Card className="w-full">
        {header}
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertTitle>Could not load custom routers</AlertTitle>
            <AlertDescription>{query.error.message}</AlertDescription>
          </Alert>
          <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full" id={`custom-routers-${scope}`}>
      {header}
      <CardContent className="space-y-3">
        {query.isRefetchError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not refresh custom routers</AlertTitle>
            <AlertDescription>{query.error.message}</AlertDescription>
          </Alert>
        ) : null}
        {routers.length === 0 ? (
          <div className="bg-muted/30 space-y-3 rounded-md border border-dashed p-4" role="status">
            <p className="text-muted-foreground text-sm">
              {canCreate
                ? 'No custom routers yet. Create one to route between models you pick, including local models added from the CLI.'
                : 'No custom routers yet. Organization owners, admins, and billing managers can create them.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {routers.map(router => (
              <CustomRouterItem
                key={router.id}
                router={router}
                deleting={deleteMutation.isPending && deleteMutation.variables?.id === router.id}
                onEdit={() => setEditor({ router })}
                onDelete={() => deleteMutation.mutateAsync(router)}
              />
            ))}
          </ul>
        )}
      </CardContent>
      {editor ? (
        <CustomRouterDialog
          scope={scope}
          organizationId={organizationId}
          router={editor.router}
          onClose={() => setEditor(null)}
          onSaved={saved => {
            setEditor(null);
            toast.success(editor.router ? `Saved ${saved.name}` : `Created ${saved.name}`);
            void queryClient.invalidateQueries({ queryKey });
          }}
        />
      ) : null}
    </Card>
  );
}

function CustomRouterItem({
  router,
  deleting,
  onEdit,
  onDelete,
}: {
  router: CustomRouterSummary;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const baseLabel = BASE_ROUTER_OPTIONS.find(option => option.value === router.baseRouter)?.label;
  const modeLabel = MODE_OPTIONS.find(option => option.value === router.mode)?.label;
  const defaultEntry = router.entries.find(entry => entry.key === router.defaultEntryKey);
  const needsEval = router.entries.some(entry => entry.needsClientEval);

  return (
    <li className="bg-card space-y-3 rounded-md border p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{router.name}</p>
          <p className="text-muted-foreground truncate font-mono text-sm">{router.modelId}</p>
          <p className="text-muted-foreground text-sm">
            Benchmark difficulty: {baseLabel} · {modeLabel}
            {defaultEntry ? ` · Default: ${entryLabel(defaultEntry.entry)}` : null}
          </p>
          {router.legacyPool ? (
            <p className="text-muted-foreground text-sm">
              Shared with kilo-auto/efficient during the transition.
            </p>
          ) : null}
        </div>
        {router.canEdit ? (
          <div className="flex shrink-0 items-start gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={deleting} onClick={onEdit}>
              <Pencil className="size-4" aria-hidden />
              Edit
            </Button>
            {!router.legacyPool ? (
              <InlineDeleteConfirmation
                onDelete={onDelete}
                isLoading={deleting}
                confirmText="Delete router"
                warningText={`Requests that use ${router.modelId} will fail.`}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <ul className="space-y-1.5">
        {router.entries.map(entry => {
          const status = entryDisplayStatus(entry);
          return (
            <li
              key={entry.key}
              className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono">{entryLabel(entry.entry)}</span>
                {entry.entry.kind === 'client' ? <Badge variant="secondary">Client</Badge> : null}
              </div>
              <div className="flex flex-col sm:items-end">
                <span
                  data-status={status.kind}
                  className={cn(
                    'font-medium',
                    status.kind === 'failed' && 'text-destructive',
                    (status.kind === 'unknown' || status.kind === 'missing') &&
                      'text-muted-foreground'
                  )}
                >
                  {status.label}
                </span>
                {status.detail ? (
                  <span className="text-muted-foreground text-xs">{status.detail}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {needsEval ? (
        <Alert>
          <AlertTitle>Client eval needed</AlertTitle>
          <AlertDescription>
            <span>
              Some models in this pool are measured on your machine. Run{' '}
              <code className="font-mono">kilo auto eval {router.modelId}</code> in the CLI.
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
    </li>
  );
}
