'use client';

import { useId } from 'react';

import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { cn } from '@/lib/utils';
import type { AgentSummary } from '@/lib/kiloclaw/types';

import { stripKilocodeModelPrefix } from './modelSupport';

// Sentinel option meaning "clear the agent's own model and inherit the default".
// Mapped back to a model unset by the caller.
export const USE_DEFAULT_MODEL = '__default__';
// Marker for a fallback-only override (rawModel set, no primary). Shown so the
// override isn't misrendered as the default; selecting it is a no-op.
const FALLBACK_ONLY = '__fallbacks__';

// The agent's OWN primary model id (bare, un-prefixed), '' if it has none.
export function ownPrimaryModel(agent: AgentSummary): string {
  const raw = agent.rawModel;
  if (typeof raw === 'string') return stripKilocodeModelPrefix(raw);
  if (raw && typeof raw === 'object' && raw.primary) return stripKilocodeModelPrefix(raw.primary);
  return '';
}

// The agent's OWN model fallbacks, preserved across an inline primary change.
export function ownModelFallbacks(agent: AgentSummary): string[] {
  const raw = agent.rawModel;
  if (raw && typeof raw === 'object') return raw.fallbacks ?? [];
  return [];
}

// Channel-key-only default routes this surface manages (lowercased to match the
// controller's managed-set + the lowercase catalog ids).
export function managedChannels(agent: AgentSummary): string[] {
  return agent.bindings
    .filter(b => !b.advanced && b.accountId === null)
    .map(b => b.channel.toLowerCase());
}

export type ChannelCatalogEntry = { id: string; label: string; configured: boolean };

/**
 * Inline per-agent model picker for the agents list row. A compact combobox with
 * a leading "Use the default model" option; selecting saves immediately. `onChange`
 * receives the bare model id, or null to clear the override.
 */
export function AgentModelControl({
  agent,
  models,
  isLoading,
  error,
  saving,
  disabled,
  onChange,
}: {
  agent: AgentSummary;
  models: ModelOption[];
  isLoading: boolean;
  error: string | undefined;
  saving: boolean;
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const primary = ownPrimaryModel(agent);
  const hasOwnModel = agent.rawModel != null;

  // Reserve USE_DEFAULT_MODEL for an agent that TRULY inherits (rawModel === null).
  // An agent that owns a model must never display as the default — otherwise the
  // combobox falls back to the placeholder and selecting it would silently clear
  // the override. So surface real overrides as their own options:
  //  - a primary that isn't in the current catalog (so it doesn't show the placeholder)
  //  - a fallback-only model (no primary) as an explicit, non-default entry
  const extra: ModelOption[] = [];
  let value: string;
  if (!hasOwnModel) {
    value = USE_DEFAULT_MODEL;
  } else if (primary !== '') {
    value = primary;
    if (!models.some(m => m.id === primary)) {
      extra.push({ id: primary, name: `${primary} (not in catalog)` });
    }
  } else {
    value = FALLBACK_ONLY;
    extra.push({
      id: FALLBACK_ONLY,
      name: `Fallbacks only: ${ownModelFallbacks(agent).join(', ') || '(none)'}`,
    });
  }
  const options: ModelOption[] = [
    { id: USE_DEFAULT_MODEL, name: 'Use the default model' },
    ...extra,
    ...models,
  ];
  return (
    <ModelCombobox
      label=""
      variant="compact"
      models={options}
      value={value}
      onValueChange={v => {
        // Re-selecting the fallback-only marker is a no-op (it's the current
        // state, and it carries no primary to write).
        if (v === FALLBACK_ONLY) return;
        onChange(v === USE_DEFAULT_MODEL ? null : v);
      }}
      isLoading={isLoading}
      error={error}
      disabled={disabled || saving}
      placeholder="Use the default model"
      modal
      className="h-8 w-full max-w-xs"
    />
  );
}

/**
 * Inline per-agent channel routing for the agents list row: a toggle chip per
 * catalog channel. Clicking saves immediately (declarative full set). Channels
 * routed to another agent are disabled. `channelOwner` maps a channel id to the
 * name of whichever agent currently owns its default route.
 */
export function AgentChannelsControl({
  agent,
  catalog,
  isLoading,
  channelOwner,
  saving,
  onChange,
}: {
  agent: AgentSummary;
  catalog: ChannelCatalogEntry[];
  isLoading: boolean;
  channelOwner: Map<string, string>;
  saving: boolean;
  onChange: (channels: string[]) => void;
}) {
  // Namespace the per-chip reason ids so multiple rows on the page don't collide.
  const reasonBaseId = useId();
  if (isLoading) {
    return <span className="text-muted-foreground text-xs">Loading channels…</span>;
  }
  if (catalog.length === 0) {
    return <span className="text-muted-foreground text-xs">No channels available</span>;
  }
  const selected = new Set(managedChannels(agent));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {catalog.map(channel => {
        const isSelected = selected.has(channel.id);
        const owner = channelOwner.get(channel.id);
        // Owned by another agent (not this one) → can't route here until moved.
        const ownedElsewhere = owner !== undefined && !isSelected;
        const blocked = saving || ownedElsewhere;
        // Why a chip is unavailable, exposed via a visually-hidden description
        // (and aria-describedby) rather than a hover-only `title`, which screen
        // readers and touch users can't reach. The chip stays focusable via
        // aria-disabled (a native `disabled` button is skipped by the tab order),
        // and onClick no-ops while blocked.
        const reason = ownedElsewhere
          ? `Routed to ${owner}`
          : !channel.configured
            ? 'Channel not configured'
            : undefined;
        const reasonId = reason ? `${reasonBaseId}-${channel.id}` : undefined;
        return (
          <span key={channel.id} className="contents">
            <button
              type="button"
              aria-disabled={blocked || undefined}
              aria-pressed={isSelected}
              aria-describedby={reasonId}
              onClick={() => {
                if (blocked) return;
                toggle(channel.id);
              }}
              className={cn(
                'rounded-full border px-2 py-0.5 text-xs transition-colors',
                isSelected
                  ? 'border-border bg-accent text-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent/50',
                !channel.configured && !isSelected && 'opacity-60',
                blocked && 'cursor-not-allowed opacity-50'
              )}
            >
              {channel.label}
            </button>
            {reason && (
              <span id={reasonId} className="sr-only">
                {channel.label}: {reason}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
