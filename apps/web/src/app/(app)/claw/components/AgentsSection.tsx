'use client';

import { Bot, Check, Loader2, Pencil, Plus, Radio, RotateCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { type ModelOption } from '@/components/shared/ModelCombobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
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
  useRestartRequired,
} from '../hooks/useClawHooks';
import { useClawModelOptions } from '../hooks/useClawModelOptions';
import { AgentCreateDialog } from './AgentCreateDialog';
import { AgentDefaultsDialog } from './AgentDefaultsDialog';
import { AgentEditDialog } from './AgentEditDialog';
import {
  AgentChannelsControl,
  AgentModelControl,
  managedChannels,
  ownModelFallbacks,
  ownPrimaryModel,
  type ChannelCatalogEntry,
} from './AgentInlineControls';
import { useClawContext } from './ClawContext';
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
  canUpdate,
  canDelete,
  canBindings,
  modelOptions,
  isLoadingModels,
  modelError,
  catalog,
  isLoadingChannels,
  channelOwner,
  savingModel,
  savingChannels,
  onEditAdvanced,
  onDelete,
  onSetModel,
  onSetChannels,
}: {
  agent: AgentSummary;
  canUpdate: boolean;
  canDelete: boolean;
  canBindings: boolean;
  // Shared data + handlers are hoisted to AgentsSection so the list subscribes to
  // the model/channel queries and mutations once, not once per row.
  modelOptions: ModelOption[];
  isLoadingModels: boolean;
  modelError: string | undefined;
  catalog: ChannelCatalogEntry[];
  isLoadingChannels: boolean;
  channelOwner: Map<string, string>;
  savingModel: boolean;
  savingChannels: boolean;
  onEditAdvanced: () => void;
  onDelete: () => void;
  onSetModel: (value: string | null) => void;
  onSetChannels: (channels: string[]) => void;
}) {
  const settings = settingChips(agent.settings);
  // `main` is reserved and cannot be deleted (controller rejects it).
  const deletable = canDelete && agent.id !== 'main';
  // Channel edits target agents in agents.list; the implicit (unconfigured) main
  // is rejected with agent_not_found, so it stays read-only until configured.
  const canEditChannels = canBindings && agent.configured;

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
            saving={savingModel}
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
            catalog={catalog}
            isLoading={isLoadingChannels}
            channelOwner={channelOwner}
            saving={savingChannels}
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
      {/* min-w-0 + truncate so a long model id / fallback list ellipsizes instead
          of pushing the shrink-0 edit button off-screen on narrow viewports. */}
      <p className="text-muted-foreground min-w-0 truncate text-xs">
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
  instanceId,
  canCreate,
  canUpdate,
  canDelete,
  canBindings,
  canEditDefaults,
}: {
  enabled: boolean;
  // Postgres id of the instance whose agents these are; keys the persisted
  // "restart required" count so it tracks the actual instance, not the
  // org/personal context. Null until status loads (count falls back to memory).
  instanceId: string | null;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canBindings: boolean;
  canEditDefaults: boolean;
}) {
  const { data, isLoading, error } = useClawAgents(enabled);
  const { deleteAgent, refetchAgents, updateAgent, updateBindings } = useClawAgentMutations();
  // Shared across the whole list (subscribed once, not per row), and gated so
  // these fetches don't fire on a stopped machine (enabled=false) or for users
  // who can't edit the thing (the picker / chips never render in those cases).
  const {
    modelOptions,
    isLoading: isLoadingModels,
    error: modelError,
  } = useClawModelOptions(enabled && canUpdate);
  const { data: catalog, isLoading: isLoadingChannels } = useClawChannelCatalog(
    enabled && canBindings
  );

  // Which agent's inline model / channels save is in flight, so only that row's
  // control shows pending (the mutations themselves are shared).
  const [savingModelFor, setSavingModelFor] = useState<string | null>(null);
  const [savingChannelsFor, setSavingChannelsFor] = useState<string | null>(null);

  // A channel binding writes config but the running gateway does NOT hot-reload
  // routing — it only takes effect after a gateway restart (the same way env /
  // config changes apply across this product). So binds save instantly, we count
  // the unapplied ones, and let the user restart ONCE when done (no per-toggle
  // restart; batches a whole multi-agent setup into one apply). See plan B2.
  const { organizationId } = useClawContext();
  const personalInstance = useKiloClawMutations();
  const orgInstance = useOrgKiloClawMutations(organizationId ?? '');
  const restartOpenClaw = organizationId
    ? orgInstance.restartOpenClaw
    : personalInstance.restartOpenClaw;
  // Persisted per-instance so the "restart required" warning survives navigating
  // away / refreshing (the config change is persistent, only the runtime is stale).
  const {
    count: pendingChangeCount,
    bump: bumpPendingChange,
    clear: clearPendingChange,
  } = useRestartRequired(instanceId);

  const onRestartToApply = async () => {
    try {
      await restartOpenClaw.mutateAsync(undefined);
      clearPendingChange();
      toast.success('Restarting OpenClaw — routing changes apply when it’s back.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restart OpenClaw', {
        duration: 10000,
      });
    }
  };

  const [createOpen, setCreateOpen] = useState(false);
  // Freeze the agent AND the etag together when opening an editor, so a
  // background list refetch can't advance the etag under a stale form (which
  // would let a save bypass the optimistic-concurrency check).
  const [editTarget, setEditTarget] = useState<{ agent: AgentSummary; etag: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentSummary | null>(null);
  // Freeze the config-wide etag when opening the defaults editor (same reason as
  // the per-agent editors: a background refetch must not advance it under a
  // stale form and let a save bypass the concurrency check).
  // Freeze BOTH the defaults baseline and its etag at open time. Passing live
  // `data.defaults` into the open dialog would let a background refetch shift the
  // form's baseline under the user while the etag stayed pinned, making a stale
  // patch look valid.
  const [defaultsTarget, setDefaultsTarget] = useState<{
    defaults: AgentDefaultsSummary;
    etag: string;
  } | null>(null);

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

  // channel id -> the agent that owns its default route, computed once for the
  // whole list. A self-owned channel is already checked/selected in its own row,
  // so the picker's "owned elsewhere" test (owner present AND not selected) only
  // disables channels routed to a DIFFERENT agent.
  const channelOwner = useMemo(() => {
    const map = new Map<string, string>();
    // Reuse managedChannels so the "managed default route" predicate lives in one
    // place (shared with the picker); a drift here would wrongly enable/disable chips.
    for (const a of agents) {
      for (const channel of managedChannels(a)) map.set(channel, a.name ?? a.id);
    }
    return map;
  }, [agents]);

  const handleSetModel = async (agent: AgentSummary, value: string | null) => {
    if (!data) return;
    const fallbacks = ownModelFallbacks(agent);
    const patch: AgentUpdateInput =
      value === null
        ? { etag: data.etag, set: {}, unset: ['model'] }
        : {
            etag: data.etag,
            set: {
              model: {
                primary: addKilocodeModelPrefix(value),
                ...(fallbacks.length > 0 ? { fallbacks } : {}),
              },
            },
            unset: [],
          };
    const label = agent.name ?? agent.id;
    setSavingModelFor(agent.id);
    // Inline saves have no Save button and the round-trip is slow, so a loading
    // toast that resolves in place is the "working in the background" signal —
    // otherwise the click looks dead until the control updates on refetch.
    const toastId = toast.loading(`Saving model for ${label}…`);
    try {
      await updateAgent.mutateAsync(agent.id, patch);
      // Saved, but the model edit doesn't hot-reload — needs a restart to apply
      // (confirmed 2026-06-15, same as bindings).
      bumpPendingChange();
      toast.success(`Saved model for ${label}`, { id: toastId });
    } catch (err) {
      // Like create/delete, an update can time out AFTER the controller committed
      // it. Reconcile against the intended state; if it landed, treat as saved +
      // mark restart-required so the banner appears.
      const applied = await reconcileAmbiguousMutation(err, refetchAgents, list => {
        const a = list.agents.find(x => x.id === agent.id);
        if (!a) return false;
        return value === null ? a.rawModel == null : ownPrimaryModel(a) === value;
      });
      if (applied) {
        bumpPendingChange();
        toast.success(`Saved model for ${label}`, { id: toastId });
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to update model', {
          id: toastId,
          duration: 10000,
        });
      }
    } finally {
      setSavingModelFor(null);
    }
  };

  const handleSetChannels = async (agent: AgentSummary, channels: string[]) => {
    if (!data) return;
    const label = agent.name ?? agent.id;
    setSavingChannelsFor(agent.id);
    const toastId = toast.loading(`Saving channels for ${label}…`);
    try {
      await updateBindings.mutateAsync(agent.id, { etag: data.etag, channels });
      // Saved, but routing doesn't hot-reload — needs a gateway restart (B2 finding).
      bumpPendingChange();
      toast.success(`Saved channels for ${label}`, { id: toastId });
    } catch (err) {
      // A binding write can time out AFTER the controller committed it; reconcile
      // against the requested channel set before reporting failure.
      const want = new Set(channels);
      const applied = await reconcileAmbiguousMutation(err, refetchAgents, list => {
        const a = list.agents.find(x => x.id === agent.id);
        if (!a) return false;
        const now = new Set(managedChannels(a));
        return now.size === want.size && [...want].every(c => now.has(c));
      });
      if (applied) {
        bumpPendingChange();
        toast.success(`Saved channels for ${label}`, { id: toastId });
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to update channels', {
          id: toastId,
          duration: 10000,
        });
      }
    } finally {
      setSavingChannelsFor(null);
    }
  };

  return (
    <div>
      {enabled && pendingChangeCount > 0 && (
        <div className="bg-secondary/40 mb-3 flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
          <p className="text-muted-foreground text-xs">
            <span className="text-foreground font-medium">
              {pendingChangeCount} change{pendingChangeCount === 1 ? '' : 's'} saved.
            </span>{' '}
            Agent changes (model, channels, behavior) only take effect after the machine restarts —
            restart OpenClaw to apply {pendingChangeCount === 1 ? 'it' : 'them'}.
          </p>
          <Button
            size="sm"
            className="shrink-0"
            onClick={onRestartToApply}
            disabled={restartOpenClaw.isPending}
          >
            {restartOpenClaw.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4" />
            )}
            Restart OpenClaw
          </Button>
        </div>
      )}

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
                canUpdate={canUpdate}
                canDelete={canDelete}
                canBindings={canBindings}
                modelOptions={modelOptions}
                isLoadingModels={isLoadingModels}
                modelError={modelError}
                catalog={catalog ?? []}
                isLoadingChannels={isLoadingChannels}
                channelOwner={channelOwner}
                savingModel={savingModelFor === agent.id}
                savingChannels={savingChannelsFor === agent.id}
                onEditAdvanced={() => setEditTarget({ agent, etag: data.etag })}
                onDelete={() => setDeleteTarget(agent)}
                onSetModel={value => handleSetModel(agent, value)}
                onSetChannels={channels => handleSetChannels(agent, channels)}
              />
            ))}
            <DefaultsRow
              defaults={data.defaults}
              canEdit={canEditDefaults}
              onEdit={() => setDefaultsTarget({ defaults: data.defaults, etag: data.etag })}
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
          onApplied={() => bumpPendingChange()}
        />
      )}

      {defaultsTarget && (
        <AgentDefaultsDialog
          open
          onOpenChange={open => {
            if (!open) setDefaultsTarget(null);
          }}
          defaults={defaultsTarget.defaults}
          etag={defaultsTarget.etag}
          onApplied={() => bumpPendingChange()}
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
