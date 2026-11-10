'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';
import {
  smartFolderPresetSchema,
  type SmartFolderPreset,
  type WorkspaceOrder,
} from '@/lib/cloud-agent/workspace-folders';
import {
  getSmartFolderToggle,
  SIDEBAR_SORT_OPTIONS,
  SMART_FOLDER_DEFINITIONS,
} from './sidebar-settings';
import { cn } from '@/lib/utils';

export function SidebarSettingsSection({ organizationId }: { organizationId?: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const scope = { organizationId: organizationId ?? null };
  const invalidateSidebar = () => {
    void queryClient.invalidateQueries(trpc.workspaceFolders.list.pathFilter());
    void queryClient.invalidateQueries(trpc.cloudAgentSettings.getWorkspaceOrder.pathFilter());
    void queryClient.invalidateQueries(trpc.cliSessionsV2.listWorkspaces.pathFilter());
  };
  const foldersQuery = useQuery(trpc.workspaceFolders.list.queryOptions(scope));
  const preferencesQuery = useQuery(trpc.cloudAgentSettings.getWorkspaceOrder.queryOptions());

  const createFolder = useMutation(
    trpc.workspaceFolders.create.mutationOptions({
      onSuccess: invalidateSidebar,
    })
  );
  const updateFolder = useMutation(
    trpc.workspaceFolders.update.mutationOptions({
      onSuccess: invalidateSidebar,
    })
  );
  const deleteFolder = useMutation(
    trpc.workspaceFolders.delete.mutationOptions({
      onSuccess: invalidateSidebar,
    })
  );
  const setWorkspaceOrder = useMutation(
    trpc.cloudAgentSettings.setWorkspaceOrder.mutationOptions({
      onSuccess: invalidateSidebar,
    })
  );

  const folders = foldersQuery.data?.folders ?? [];
  const smartFolderFor = (preset: SmartFolderPreset) =>
    folders.find(folder => folder.kind === 'smart' && folder.smartPreset === preset);
  const busy =
    createFolder.isPending ||
    updateFolder.isPending ||
    deleteFolder.isPending ||
    setWorkspaceOrder.isPending;

  const toggleSmartFolder = (preset: SmartFolderPreset, enabled: boolean) => {
    const toggle = getSmartFolderToggle(folders, preset, enabled);
    if (!toggle) return;
    if (toggle.action === 'delete') {
      deleteFolder.mutate({ ...scope, folderId: toggle.folderId });
      return;
    }
    createFolder.mutate({
      ...scope,
      name: toggle.definition.name,
      color: toggle.definition.color,
      kind: 'smart',
      smartPreset: smartFolderPresetSchema.parse(preset),
    });
  };

  if (foldersQuery.isPending || preferencesQuery.isPending) {
    return (
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Loading sidebar settings...</span>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (foldersQuery.isError || preferencesQuery.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="text-sm">Could not load sidebar settings.</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void foldersQuery.refetch();
            void preferencesQuery.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Workspace order</h3>
          <Badge variant="secondary">Only you</Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          This order is personal to you. It applies to your personal account and to all your
          organizations.
        </p>
        <div className="flex flex-wrap gap-2">
          {SIDEBAR_SORT_OPTIONS.map(option => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={
                preferencesQuery.data?.workspaceOrder === option.value ? 'default' : 'outline'
              }
              disabled={busy}
              onClick={() =>
                setWorkspaceOrder.mutate({
                  workspaceOrder: option.value satisfies WorkspaceOrder,
                })
              }
            >
              {option.label}
            </Button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="size-4" aria-hidden /> Smart folders
          </h3>
          <Badge variant="secondary">Only you</Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          Smart folders group workspaces automatically. Add one to the sidebar, set its order, and
          remove it without deleting any workspace.
        </p>
        <div className="flex flex-col gap-3">
          {SMART_FOLDER_DEFINITIONS.map(definition => {
            const folder = smartFolderFor(definition.preset);
            const enabled = Boolean(folder);
            return (
              <div
                key={definition.preset}
                data-testid={`smart-folder-${definition.preset}`}
                className={cn(
                  'flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between',
                  enabled && 'bg-muted/30'
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{definition.name}</p>
                  <p className="text-muted-foreground text-xs">{definition.description}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {enabled && folder && (
                    <select
                      aria-label={`Sort ${definition.name}`}
                      className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                      value={folder.sortMode}
                      disabled={busy}
                      onChange={event => {
                        const value = event.target.value;
                        if (value === 'manual' || value === 'created' || value === 'activity') {
                          updateFolder.mutate({
                            ...scope,
                            folderId: folder.id,
                            sortMode: value,
                          });
                        }
                      }}
                    >
                      {SIDEBAR_SORT_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant={enabled ? 'outline' : 'default'}
                    disabled={busy}
                    aria-pressed={enabled}
                    onClick={() => toggleSmartFolder(definition.preset, !enabled)}
                  >
                    {busy && (
                      <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
                    )}
                    {enabled ? 'Remove' : 'Add to sidebar'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <p className="text-muted-foreground text-xs">
        Drag a workspace onto a folder or between rows to change its position. The first drag
        assigns positions once; later drags only move the workspace you dragged.
      </p>
    </div>
  );
}
