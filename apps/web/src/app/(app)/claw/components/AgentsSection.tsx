'use client';

import { Bot, Check, Loader2, Pencil, Plus, Radio, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { type AgentUpdateInput } from '@/lib/kiloclaw/agent-schemas';
import type {
  AgentDefaultsSummary,
  AgentSettingsSummary,
  AgentSummary,
} from '@/lib/kiloclaw/types';

import {
  reconcileAmbiguousMutation,
  useClawAgentMutations,
  useClawAgents,
  useClawChannelCatalog,
} from '../hooks/useClawHooks';
import { useClawModelOptions } from '../hooks/useClawModelOptions';
import { AgentCreateDialog } from './AgentCreateDialog';
import { AgentDefaultsDialog } from './AgentDefaultsDialog';
import { AgentEditDialog } from './AgentEditDialog';
import { AgentChannelsControl, AgentModelControl, ownModelFallbacks } from './AgentInlineControls';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { DetailTile } from './DetailTile';
import { addKilocodeModelPrefix } from './modelSupport';

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
      {/* Model refs are identifiers — Roboto Mono per typography.md. */}
      <span className="font-mono">{label}</span>
      {model.source === 'defaults' && <span className="text-muted-foreground"> (inherited)</span>}
    </span>
  );
}

// Read-only channel badges for an agent whose channels can't be edited here
// (no bindings capability, or the implicit/unconfigured main).
function ReadonlyChannels({ agent }: { agent: AgentSummary }) {
  if (agent.bindings.length === 0) {
    return <span className="text-muted-foreground text-xs">none</span>;
  }
  // accountId null vs '' are distinct routes and advanced bindings can repeat
  // channel+account, so the array index is the stable key here.
  return (
    <>
      {agent.bindings.map((binding, index) => (
        <Badge key={index} variant="outline" className="px-1.5 py-0 text-[10px] leading-4">
          {binding.channel}
          {binding.accountId !== null &&
            ` (${binding.accountId === '' ? 'blank account' : binding.accountId})`}
          {binding.advanced ? ' · advanced' : ''}
        </Badge>
      ))}
    </>
  );
}

function AgentRow({
  agent,
  agents,
  etag,
  canUpdate,
  canDelete,
  canBindings,
  onEditAdvanced,
  onDelete,
}: {
  agent: AgentSummary;
  // The full agent list, so the channels picker can disable channels another agent owns.
  agents: AgentSummary[];
  etag: string;
  canUpdate: boolean;
  canDelete: boolean;
  canBindings: boolean;
  onEditAdvanced: () => void;
  onDelete: () => void;
}) {
  // Per-row mutations so each row's saving state is independent.
  const { updateAgent, updateBindings } = useClawAgentMutations();
  const { modelOptions, isLoading: isLoadingModels, error: modelError } = useClawModelOptions();
  const { data: catalog, isLoading: isLoadingChannels } = useClawChannelCatalog();

  const settings = settingChips(agent.settings);
  // `main` is reserved and cannot be deleted (controller rejects it).
  const deletable = canDelete && agent.id !== 'main';
  // Channel edits target agents in agents.list; the implicit (unconfigured) main
  // is rejected with agent_not_found, so it stays read-only until configured.
  const canEditChannels = canBindings && agent.configured;

  // channel id -> the OTHER agent that owns its default route (self excluded), so
  // the picker can disable a channel already routed elsewhere.
  const channelOwner = useMemo(() => {
    const map = new Map<string, string>();
    for (const other of agents) {
      if (other.id === agent.id) continue;
      for (const channel of other.bindings) {
        if (!channel.advanced && channel.accountId === null) {
          map.set(channel.channel.toLowerCase(), other.name ?? other.id);
        }
      }
    }
    return map;
  }, [agents, agent.id]);

  const onSetModel = async (value: string | null) => {
    const fallbacks = ownModelFallbacks(agent);
    const patch: AgentUpdateInput =
      value === null
        ? { etag, set: {}, unset: ['model'] }
        : {
            etag,
            set: {
              model: {
                primary: addKilocodeModelPrefix(value),
                ...(fallbacks.length > 0 ? { fallbacks } : {}),
              },
            },
            unset: [],
          };
    try {
      await updateAgent.mutateAsync(agent.id, patch);
      toast.success(`Updated model for ${agent.name ?? agent.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update model', {
        duration: 10000,
      });
    }
  };

  const onSetChannels = async (channels: string[]) => {
    try {
      await updateBindings.mutateAsync(agent.id, { etag, channels });
      toast.success(`Updated channels for ${agent.name ?? agent.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update channels', {
        duration: 10000,
      });
    }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{agent.name ?? agent.id}</span>
          {agent.name && (
            <span className="text-muted-foreground font-mono text-xs">{agent.id}</span>
          )}
          {!agent.configured && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] leading-4">
              Default
            </Badge>
          )}
        </div>
        {(canUpdate || deletable) && (
          <div className="flex shrink-0 items-center gap-1">
            {canUpdate && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={onEditAdvanced}
                aria-label="Advanced settings"
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            {deletable && (
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive hover:text-destructive h-8 w-8"
                onClick={onDelete}
                aria-label="Delete agent"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-muted-foreground w-16 shrink-0 text-xs">Model</span>
        {canUpdate ? (
          <AgentModelControl
            agent={agent}
            models={modelOptions}
            isLoading={isLoadingModels}
            error={modelError}
            saving={updateAgent.isPending}
            onChange={onSetModel}
          />
        ) : (
          <span className="text-xs">
            <AgentModelLabel model={agent.model} />
          </span>
        )}
      </div>

      <div className="mt-2 flex items-start gap-2">
        <span className="text-muted-foreground mt-0.5 w-16 shrink-0 text-xs">Channels</span>
        {canEditChannels ? (
          <AgentChannelsControl
            agent={agent}
            catalog={catalog ?? []}
            isLoading={isLoadingChannels}
            channelOwner={channelOwner}
            saving={updateBindings.isPending}
            onChange={onSetChannels}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <ReadonlyChannels agent={agent} />
          </div>
        )}
      </div>

      {settings.length > 0 && (
        <div className="text-muted-foreground mt-2 text-xs">{settings.join(' · ')}</div>
      )}
    </div>
  );
}

function DefaultsRow({
  defaults,
  canEdit,
  onEdit,
}: {
  defaults: AgentDefaultsSummary;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const settings = settingChips(defaults.settings);
  // Defaults can be fallback-only (primary null, fallbacks set) — don't show "none".
  const modelLabel = defaults.model
    ? defaults.model.primary ||
      (defaults.model.fallbacks.length > 0
        ? `fallbacks: ${defaults.model.fallbacks.join(', ')}`
        : 'none')
    : 'none';

  return (
    <div className="bg-muted/30 flex items-center justify-between gap-2 px-4 py-3">
      <p className="text-muted-foreground text-xs">
        <span className="font-medium">Inherited defaults</span> · Model:{' '}
        <span className="font-mono">{modelLabel}</span>
        {settings.length > 0 && ` · ${settings.join(' · ')}`}
      </p>
      {canEdit && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onEdit}
          aria-label="Edit inherited defaults"
        >
          <Pencil className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

/**
 * Agents view: lists the agents running on the user's machine and the channels
 * routed to each, with create / edit / delete. Gated by the controller's
 * `config.agents.read` capability and admin status at the call site.
 */
export function AgentsSection({
  enabled,
  canCreate,
  canUpdate,
  canDelete,
  canBindings,
  canEditDefaults,
}: {
  enabled: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canBindings: boolean;
  canEditDefaults: boolean;
}) {
  const { data, isLoading, error } = useClawAgents(enabled);
  const { deleteAgent, refetchAgents } = useClawAgentMutations();

  const [createOpen, setCreateOpen] = useState(false);
  // Freeze the agent AND the etag together when opening an editor, so a
  // background list refetch can't advance the etag under a stale form (which
  // would let a save bypass the optimistic-concurrency check).
  const [editTarget, setEditTarget] = useState<{ agent: AgentSummary; etag: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);
  // Freeze the config-wide etag when opening the defaults editor (same reason as
  // the per-agent editors: a background refetch must not advance it under a
  // stale form and let a save bypass the concurrency check).
  const [defaultsTarget, setDefaultsTarget] = useState<{ etag: string } | null>(null);

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
      // the agent (fire-and-forget); reconcile ambiguous failures against the
      // live list (the agent being gone = applied).
      const applied = await reconcileAmbiguousMutation(
        err,
        refetchAgents,
        list => !list.agents.some(a => a.id === id)
      );
      if (applied) {
        toast.success(`Deleted ${label}`);
        setDeleteTarget(null);
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Failed to delete agent', {
        duration: 10000,
      });
    }
  };

  // Agent metrics, all derived from the loaded list (no extra fetch): how many
  // agents, how many carry their own config (vs inheriting), and how many
  // distinct channels are routed to a non-default agent.
  const agents = data?.agents ?? [];
  const configuredCount = agents.filter(a => a.configured).length;
  const routedChannels = new Set(agents.flatMap(a => a.bindings.map(b => b.channel))).size;

  return (
    <div>
      {enabled && data && (
        <div className="mb-4 flex flex-col gap-3">
          {/* Stat tiles — same DetailTile pattern as the Settings page so the
              two KiloClaw surfaces read consistently. All from the loaded list. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <DetailTile label="Agents" value={String(agents.length)} icon={Bot} />
            <DetailTile label="Configured" value={String(configuredCount)} icon={Check} />
            <DetailTile label="Channels routed" value={String(routedChannels)} icon={Radio} />
          </div>
          {canCreate && (
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                Create agent
              </Button>
            </div>
          )}
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
          <div className="text-muted-foreground px-4 py-3 text-xs">
            No agents yet. Create one to give a channel its own assistant.
          </div>
        ) : (
          <div className="[&>*+*]:border-t">
            {data.agents.map(agent => (
              <AgentRow
                key={agent.id}
                agent={agent}
                agents={data.agents}
                etag={data.etag}
                canUpdate={canUpdate}
                canDelete={canDelete}
                canBindings={canBindings}
                onEditAdvanced={() => setEditTarget({ agent, etag: data.etag })}
                onDelete={() => setDeleteTarget(agent)}
              />
            ))}
            <DefaultsRow
              defaults={data.defaults}
              canEdit={canEditDefaults}
              onEdit={() => setDefaultsTarget({ etag: data.etag })}
            />
          </div>
        )}
      </div>

      <p className="text-muted-foreground mt-2 text-xs">
        The agents running on your machine and the channels routed to each.
      </p>

      {/* Mounted only while open so its model-catalog/version queries don't run
          on every page visit (incl. read-only and stopped-machine states). */}
      {/* Gate the mount on `data` (the trigger button already requires it) so
          the pre-existence guard is always backed by a real loaded list — never
          a `?? []` fallback that would silently disable it. */}
      {createOpen && data && (
        <AgentCreateDialog
          open
          onOpenChange={setCreateOpen}
          existingIds={data.agents.map(a => a.id)}
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

      {defaultsTarget && data && (
        <AgentDefaultsDialog
          open
          onOpenChange={open => {
            if (!open) setDefaultsTarget(null);
          }}
          defaults={data.defaults}
          etag={defaultsTarget.etag}
        />
      )}

      <ConfirmActionDialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete agent"
        description={`Delete "${deleteTarget?.name ?? deleteTarget?.id ?? ''}"? This removes the agent and its channel routing. Workspace files on the machine may remain.`}
        confirmLabel="Delete agent"
        confirmVariant="destructive"
        cancelLabel="Keep agent"
        isPending={deleteAgent.isPending}
        pendingLabel="Deleting"
        onConfirm={onConfirmDelete}
      />
    </div>
  );
}
