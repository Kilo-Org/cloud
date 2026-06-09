'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { AnimatedDots } from './AnimatedDots';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type { AgentSummary } from '@/lib/kiloclaw/types';

import { useClawAgentMutations, useClawChannelCatalog } from '../hooks/useClawHooks';

// The channels this endpoint manages for an agent: plain default-account routes
// (not account-scoped or advanced — those are managed in OpenClaw).
function managedChannels(agent: AgentSummary): string[] {
  return agent.bindings.filter(b => !b.advanced && b.accountId === null).map(b => b.channel);
}

export function AgentBindingsDialog({
  open,
  onOpenChange,
  agent,
  etag,
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentSummary;
  etag: string;
  agents: AgentSummary[];
}) {
  const { updateBindings } = useClawAgentMutations();
  const { data: catalog, isLoading } = useClawChannelCatalog();

  const initial = useMemo(() => new Set(managedChannels(agent)), [agent]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(managedChannels(agent)));

  // channel -> the other agent that currently owns its default route, so we can
  // disable it (binding it here would 409; move it from that agent first).
  const ownedByOther = useMemo(() => {
    const map = new Map<string, string>();
    for (const other of agents) {
      if (other.id === agent.id) continue;
      for (const channel of managedChannels(other)) map.set(channel, other.name ?? other.id);
    }
    return map;
  }, [agents, agent.id]);

  const channels = catalog ?? [];
  const hasAdvanced = agent.bindings.some(b => b.advanced || b.accountId !== null);
  const changed = selected.size !== initial.size || [...selected].some(c => !initial.has(c));
  const canSubmit = changed && !updateBindings.isPending;

  const toggle = (id: string, on: boolean) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const onSubmit = async () => {
    if (!canSubmit) return;
    try {
      await updateBindings.mutateAsync(agent.id, { etag, channels: [...selected] });
      toast.success(`Updated channels for ${agent.name ?? agent.id}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update channels', {
        duration: 10000,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={updateBindings.isPending ? undefined : onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Channels for {agent.name ?? agent.id}</DialogTitle>
          <DialogDescription>
            Route channels to this agent. Channels already routed to another agent are shown
            disabled; remove them there first to move them here.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {isLoading ? (
            <p className="text-muted-foreground text-xs">Loading channels…</p>
          ) : channels.length === 0 ? (
            <p className="text-muted-foreground text-xs">No channels available.</p>
          ) : (
            channels.map(channel => {
              const owner = ownedByOther.get(channel.id);
              const ownedElsewhere = owner !== undefined && !selected.has(channel.id);
              return (
                <div key={channel.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`agent-channel-${channel.id}`}
                    checked={selected.has(channel.id)}
                    disabled={ownedElsewhere}
                    onCheckedChange={c => toggle(channel.id, c === true)}
                  />
                  <Label htmlFor={`agent-channel-${channel.id}`} className="font-normal">
                    {channel.label}
                    {!channel.configured && (
                      <span className="text-muted-foreground"> · not configured</span>
                    )}
                    {ownedElsewhere && (
                      <span className="text-muted-foreground"> · routed to {owner}</span>
                    )}
                  </Label>
                </div>
              );
            })
          )}
          {hasAdvanced && (
            <p className="text-muted-foreground mt-1 text-xs">
              This agent also has advanced routes (account- or peer-scoped) managed in OpenClaw;
              those are left untouched.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateBindings.isPending}
          >
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {updateBindings.isPending ? (
              <>
                Saving
                <AnimatedDots />
              </>
            ) : (
              'Save channels'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
