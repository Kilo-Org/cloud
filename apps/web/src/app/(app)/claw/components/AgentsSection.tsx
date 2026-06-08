'use client';

import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type {
  AgentDefaultsSummary,
  AgentSettingsSummary,
  AgentSummary,
} from '@/lib/kiloclaw/types';

import { useClawAgents } from '../hooks/useClawHooks';

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

function AgentRow({ agent }: { agent: AgentSummary }) {
  const settings = settingChips(agent.settings);

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{agent.name ?? agent.id}</span>
        {agent.name && <span className="text-muted-foreground text-xs">{agent.id}</span>}
        {!agent.configured && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px] leading-4">
            Default
          </Badge>
        )}
      </div>

      <div className="text-muted-foreground mt-1 text-xs">
        Model:{' '}
        {agent.model.primary ? (
          <span className="text-foreground">
            {agent.model.primary}
            {agent.model.source === 'defaults' && (
              <span className="text-muted-foreground"> (inherited)</span>
            )}
          </span>
        ) : (
          'uses default'
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground text-xs">Channels:</span>
        {agent.bindings.length === 0 ? (
          <span className="text-muted-foreground text-xs">none</span>
        ) : (
          agent.bindings.map(binding => (
            <Badge
              key={`${binding.channel}:${binding.accountId ?? ''}`}
              variant="outline"
              className="px-1.5 py-0 text-[10px] leading-4"
            >
              {binding.channel}
              {binding.accountId ? ` (${binding.accountId})` : ''}
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

  return (
    <div className="text-muted-foreground bg-muted/30 px-4 py-3 text-xs">
      <span className="font-medium">Inherited defaults</span> · Model:{' '}
      {defaults.model?.primary ?? 'none'}
      {settings.length > 0 && ` · ${settings.join(' · ')}`}
    </div>
  );
}

/**
 * Read-only view of the agents running on the user's machine and the channels
 * routed to each. Gated by the controller's `config.agents.read` capability at
 * the call site (SettingsTab).
 */
export function AgentsSection({ enabled }: { enabled: boolean }) {
  const { data, isLoading, error } = useClawAgents(enabled);

  return (
    <div>
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
              <AgentRow key={agent.id} agent={agent} />
            ))}
            <DefaultsRow defaults={data.defaults} />
          </div>
        )}
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        The agents running on your machine and the channels routed to each.
      </p>
    </div>
  );
}
