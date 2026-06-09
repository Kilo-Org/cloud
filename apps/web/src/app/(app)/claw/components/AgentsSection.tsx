'use client';

import { Loader2, Pencil, Plus, Radio, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type {
  AgentDefaultsSummary,
  AgentSettingsSummary,
  AgentSummary,
} from '@/lib/kiloclaw/types';

import {
  isAmbiguousAgentMutationError,
  useClawAgentMutations,
  useClawAgents,
} from '../hooks/useClawHooks';
import { AgentBindingsDialog } from './AgentBindingsDialog';
import { AgentCreateDialog } from './AgentCreateDialog';
import { AgentEditDialog } from './AgentEditDialog';
import { ConfirmActionDialog } from './ConfirmActionDialog';

// Compact, human-readable list of the per-agent behavioral settings that are
// actually set (null = inherits the default, so we omit it).
function settingChips(settings: AgentSettingsSummary): string[] {
  const chips: string[] = [];
  if (settings.thinkingDefault) chips.push(`thinking: ${settings.thinkingDefault}`);
  if (settings.verboseDefault) chips.push(`verbose: ${settings.verboseDefault}`);
  if (settings.reasoningDefault) chips.push(`reasoning: ${settings.reasoningDefault}`);
  if (settings.fastModeDefault != null) {
    chips.push(`fast mode: ${settings.fastModeDefault ? 'on' : 'off'}`);
  }
  return chips;
}

// Render an agent's effective model. A fallback-only agent model (no primary)
// still has source 'agent', so we must not collapse a null primary to "uses
// default" — show the fallbacks instead. Only source === null truly inherits.
function AgentModelLabel({ model }: { model: AgentSummary['model'] }) {
  const label =
    model.primary || (model.fallbacks.length > 0 ? `fallbacks: ${model.fallbacks.join(', ')}` : '');
  if (model.source === null || label === '') {
    return <>uses default</>;
  }
  return (
    <span className="text-foreground">
      {label}
      {model.source === 'defaults' && <span className="text-muted-foreground"> (inherited)</span>}
    </span>
  );
}

function AgentRow({
  agent,
  canUpdate,
  canDelete,
  canBindings,
  onEdit,
  onDelete,
  onEditChannels,
}: {
  agent: AgentSummary;
  canUpdate: boolean;
  canDelete: boolean;
  canBindings: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onEditChannels: () => void;
}) {
  const settings = settingChips(agent.settings);
  // `main` is reserved and cannot be deleted (controller rejects it).
  const deletable = canDelete && agent.id !== 'main';
  // Binding edits target agents in agents.list; the implicit (unconfigured) main
  // is rejected with agent_not_found, so don't offer the channels action for it.
  const showChannels = canBindings && agent.configured;

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{agent.name ?? agent.id}</span>
          {agent.name && <span className="text-muted-foreground text-xs">{agent.id}</span>}
          {!agent.configured && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] leading-4">
              Default
            </Badge>
          )}
        </div>
        {(canUpdate || showChannels || deletable) && (
          <div className="flex shrink-0 items-center gap-1">
            {showChannels && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={onEditChannels}
                aria-label="Edit channels"
              >
                <Radio className="h-3.5 w-3.5" />
              </Button>
            )}
            {canUpdate && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={onEdit}
                aria-label="Edit agent"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {deletable && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive h-7 px-2"
                onClick={onDelete}
                aria-label="Delete agent"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="text-muted-foreground mt-1 text-xs">
        Model: <AgentModelLabel model={agent.model} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground text-xs">Channels:</span>
        {agent.bindings.length === 0 ? (
          <span className="text-muted-foreground text-xs">none</span>
        ) : (
          // accountId null vs '' are distinct routes and advanced bindings can
          // repeat channel+account, so the array index is the stable key here.
          agent.bindings.map((binding, index) => (
            <Badge key={index} variant="outline" className="px-1.5 py-0 text-[10px] leading-4">
              {binding.channel}
              {/* accountId is verbatim; null = default-account route. An empty
                  string is still an account-scoped route, so test against null. */}
              {binding.accountId !== null &&
                ` (${binding.accountId === '' ? 'blank account' : binding.accountId})`}
              {binding.advanced ? ' · advanced' : ''}
            </Badge>
          ))
        )}
      </div>

      {settings.length > 0 && (
        <div className="text-muted-foreground mt-2 text-xs">{settings.join(' · ')}</div>
      )}
    </div>
  );
}

function DefaultsRow({ defaults }: { defaults: AgentDefaultsSummary }) {
  const settings = settingChips(defaults.settings);
  // Defaults can be fallback-only (primary null, fallbacks set) — don't show "none".
  const modelLabel = defaults.model
    ? defaults.model.primary ||
      (defaults.model.fallbacks.length > 0
        ? `fallbacks: ${defaults.model.fallbacks.join(', ')}`
        : 'none')
    : 'none';

  return (
    <div className="text-muted-foreground bg-muted/30 px-4 py-3 text-xs">
      <span className="font-medium">Inherited defaults</span> · Model: {modelLabel}
      {settings.length > 0 && ` · ${settings.join(' · ')}`}
    </div>
  );
}

/**
 * Agents view: lists the fleet running on the user's machine and the channels
 * routed to each, with create / edit / delete. Gated by the controller's
 * `config.agents.read` capability and admin status at the call site.
 */
export function AgentsSection({
  enabled,
  canCreate,
  canUpdate,
  canDelete,
  canBindings,
}: {
  enabled: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canBindings: boolean;
}) {
  const { data, isLoading, error } = useClawAgents(enabled);
  const { deleteAgent, refetchAgents } = useClawAgentMutations();

  const [createOpen, setCreateOpen] = useState(false);
  // Freeze the agent AND the etag together when opening an editor, so a
  // background list refetch can't advance the etag under a stale form (which
  // would let a save bypass the optimistic-concurrency check).
  const [editTarget, setEditTarget] = useState<{ agent: AgentSummary; etag: string } | null>(null);
  const [channelsTarget, setChannelsTarget] = useState<{
    agent: AgentSummary;
    etag: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);

  const onConfirmDelete = async () => {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
    const label = deleteTarget.name ?? deleteTarget.id;
    try {
      await deleteAgent.mutateAsync(id);
      toast.success(`Deleted ${label}`);
      setDeleteTarget(null);
    } catch (err) {
      // Delete can time out at the gateway after the controller already removed
      // the agent (fire-and-forget). Reconcile only ambiguous (timeout/internal)
      // failures; a deterministic typed error surfaces as-is.
      if (isAmbiguousAgentMutationError(err)) {
        try {
          const list = await refetchAgents();
          if (!list.agents.some(a => a.id === id)) {
            toast.success(`Deleted ${label}`);
            setDeleteTarget(null);
            return;
          }
        } catch {
          // fall through to the original error
        }
      }
      toast.error(err instanceof Error ? err.message : 'Failed to delete agent', {
        duration: 10000,
      });
    }
  };

  return (
    <div>
      {enabled && data && canCreate && (
        <div className="mb-3 flex justify-end">
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            New agent
          </Button>
        </div>
      )}

      <div className="rounded-lg border">
        {!enabled ? (
          <div className="text-muted-foreground px-4 py-3 text-xs">
            Start your machine to view its agents.
          </div>
        ) : isLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 px-4 py-3 text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading agents…
          </div>
        ) : error ? (
          <div className="text-destructive px-4 py-3 text-xs">Failed to load agents.</div>
        ) : !data || data.agents.length === 0 ? (
          <div className="text-muted-foreground px-4 py-3 text-xs">No agents configured.</div>
        ) : (
          <div className="[&>*+*]:border-t">
            {data.agents.map(agent => (
              <AgentRow
                key={agent.id}
                agent={agent}
                canUpdate={canUpdate}
                canDelete={canDelete}
                canBindings={canBindings}
                onEdit={() => setEditTarget({ agent, etag: data.etag })}
                onDelete={() => setDeleteTarget(agent)}
                onEditChannels={() => setChannelsTarget({ agent, etag: data.etag })}
              />
            ))}
            <DefaultsRow defaults={data.defaults} />
          </div>
        )}
      </div>

      <p className="text-muted-foreground mt-2 text-xs">
        The agents running on your machine and the channels routed to each.
      </p>

      {/* Mounted only while open so its model-catalog/version queries don't run
          on every page visit (incl. read-only and stopped-machine states). */}
      {createOpen && (
        <AgentCreateDialog
          open
          onOpenChange={setCreateOpen}
          existingIds={data?.agents.map(a => a.id) ?? []}
        />
      )}

      {editTarget && (
        <AgentEditDialog
          open
          onOpenChange={open => {
            if (!open) setEditTarget(null);
          }}
          agent={editTarget.agent}
          etag={editTarget.etag}
        />
      )}

      {channelsTarget && data && (
        <AgentBindingsDialog
          open
          onOpenChange={open => {
            if (!open) setChannelsTarget(null);
          }}
          agent={channelsTarget.agent}
          etag={channelsTarget.etag}
          agents={data.agents}
        />
      )}

      <ConfirmActionDialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete agent"
        description={`Delete "${deleteTarget?.name ?? deleteTarget?.id ?? ''}"? This removes the agent and its channel routing. Workspace files on the machine may remain.`}
        confirmLabel="Delete"
        isPending={deleteAgent.isPending}
        pendingLabel="Deleting"
        onConfirm={onConfirmDelete}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      />
    </div>
  );
}
