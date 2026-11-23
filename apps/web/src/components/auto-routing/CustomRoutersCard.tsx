'use client';

import type {
  CustomRouterListResponse,
  OwnerType,
  CustomRouterSummary,
} from '@kilocode/auto-routing-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Workflow } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useModelSelectorList } from '@/lib/hooks/use-openrouter-models';
import { useTRPC } from '@/lib/trpc/utils';
import { CustomRouterDialog } from './CustomRouterDialog';
import { PoolBenchmarkButton } from './PoolBenchmarkButton';
import { PoolBenchmarkWarnings } from './PoolBenchmarkWarnings';
import {
  BASE_ROUTER_OPTIONS,
  CUSTOM_ROUTERS_POLL_INTERVAL_MS,
  MODE_OPTIONS,
  customRoutersQueryKey,
  deleteCustomRouter,
  entryLabel,
  entryRoutingStatus,
  fetchCustomRouters,
  hasUnsettledEntries,
  pausedRequestInfo,
  type PausedRequestInfo,
} from './custom-router-display';

type Props = {
  organizationId?: string;
  readonly?: boolean;
};

type EditorState = { router: CustomRouterSummary | undefined } | null;

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
      hasUnsettledEntries(current.state.data.routers.filter(router => router.scope === scope))
        ? CUSTOM_ROUTERS_POLL_INTERVAL_MS
        : false,
  });

  const deleteMutation = useMutation({
    mutationFn: (router: CustomRouterSummary) => deleteCustomRouter(router, organizationId),
    onSuccess: (_result, router) => {
      queryClient.setQueryData<CustomRouterListResponse>(queryKey, current =>
        current ? { routers: current.routers.filter(item => item.id !== router.id) } : current
      );
      toast.success(`Deleted ${router.name}`);
    },
    onError: error => toast.error(error.message),
  });

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
                organizationId={organizationId}
                canEdit={!readonly && router.canEdit}
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
  organizationId,
  canEdit,
  deleting,
  onEdit,
  onDelete,
}: {
  router: CustomRouterSummary;
  organizationId: string | undefined;
  canEdit: boolean;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const baseLabel = BASE_ROUTER_OPTIONS.find(option => option.value === router.baseRouter)?.label;
  const modeLabel = MODE_OPTIONS.find(option => option.value === router.mode)?.label;
  const defaultEntry = router.entries.find(entry => entry.key === router.defaultEntryKey);
  const needsEval = router.entries.some(entry => entry.needsClientEval);

  // A row that is not serving can be paused by the pool's latest request. This
  // read-only progress fetch never quotes, starts, or charges anything.
  const trpc = useTRPC();
  const needsProgress = router.entries.some(entry => {
    const kind = entryRoutingStatus(entry).kind;
    return kind === 'not-benchmarked' || kind === 'benchmarking' || kind === 'unknown';
  });
  const progressQuery = useQuery({
    ...trpc.customRouterBenchmarks.progress.queryOptions({
      slug: router.slug,
      organizationId,
    }),
    enabled: needsProgress,
    refetchInterval: needsProgress ? CUSTOM_ROUTERS_POLL_INTERVAL_MS : false,
  });
  const pausedRequest = useMemo<PausedRequestInfo | null>(
    () => (progressQuery.data === undefined ? null : pausedRequestInfo(progressQuery.data)),
    [progressQuery.data]
  );

  // The catalog's live alias target is what distinguishes "still serving the
  // benchmarked target" from "must re-benchmark"; concrete pools never load it.
  const hasAliasEntry = router.entries.some(
    entry => entry.entry.kind === 'gateway' && entry.entry.model.startsWith('~')
  );
  const modelsQuery = useModelSelectorList(organizationId, hasAliasEntry);
  const aliasTargets = useMemo(() => {
    const targets = new Map<string, string>();
    for (const model of modelsQuery.data?.data ?? []) {
      if (model.alias_target !== undefined) targets.set(model.id, model.alias_target);
    }
    return targets;
  }, [modelsQuery.data]);

  return (
    <li className="bg-card space-y-3 rounded-md border p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{router.name}</p>
          <p className="text-muted-foreground truncate font-mono text-sm">{router.modelId}</p>
          <p className="text-muted-foreground text-sm">
            {baseLabel} benchmark difficulty · {modeLabel}
            {defaultEntry ? ` · Default: ${entryLabel(defaultEntry.entry)}` : null}
          </p>
        </div>
        {canEdit ? (
          <div className="flex shrink-0 flex-wrap items-start gap-2">
            <PoolBenchmarkButton router={router} organizationId={organizationId} />
            <Button type="button" variant="ghost" size="sm" disabled={deleting} onClick={onEdit}>
              <Pencil className="size-4" aria-hidden />
              Edit
            </Button>
            <InlineDeleteConfirmation
              onDelete={onDelete}
              isLoading={deleting}
              confirmText="Delete router"
              warningText={`Requests that use ${router.modelId} will fail.`}
            />
          </div>
        ) : null}
      </div>

      <PoolBenchmarkWarnings router={router} />

      <ul className="space-y-1.5">
        {router.entries.map(entry => {
          const status = entryRoutingStatus(entry, { paused: pausedRequest, aliasTargets });
          const label = entryLabel(entry.entry);
          const servingModels = [
            ...new Set(
              entry.variants
                .map(variant => variant.servingModel ?? null)
                .filter((model): model is string => model !== null && model !== label)
            ),
          ];
          return (
            <li
              key={entry.key}
              className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate font-mono">{label}</span>
                {servingModels.length > 0 ? (
                  <span className="text-muted-foreground font-mono text-xs break-all">
                    Serving {servingModels.join(', ')}
                  </span>
                ) : null}
                {entry.entry.kind === 'client' ? <Badge variant="secondary">Client</Badge> : null}
                {entry.entry.measuredAs ? (
                  <Badge variant="outline" className="max-w-full whitespace-normal break-all">
                    Linked to {entry.entry.measuredAs}
                  </Badge>
                ) : null}
              </div>
              <div className="flex flex-col sm:items-end">
                <span
                  data-status={status.kind}
                  className={cn(
                    'font-medium',
                    status.tone === 'destructive' && 'text-destructive',
                    status.tone === 'warning' && 'text-amber-500',
                    status.tone === 'muted' && 'text-muted-foreground'
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
