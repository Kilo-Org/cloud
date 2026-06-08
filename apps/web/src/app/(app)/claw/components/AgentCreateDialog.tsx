'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { AnimatedDots } from './AnimatedDots';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useClawAgentMutations } from '../hooks/useClawHooks';

// Derive a stable, unix-safe workspace path from the agent name so users never
// have to type a machine path. Mirrors the controller's id normalization closely
// enough to give each agent its own workspace directory.
function workspaceFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `/root/.openclaw/workspace-${slug || 'agent'}`;
}

export function AgentCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { createAgent } = useClawAgentMutations();
  const [name, setName] = useState('');
  const [model, setModel] = useState('');

  const trimmedName = name.trim();
  const trimmedModel = model.trim();
  const canSubmit = trimmedName.length > 0 && !createAgent.isPending;

  const reset = () => {
    setName('');
    setModel('');
  };

  const close = (next: boolean) => {
    if (createAgent.isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const onSubmit = async () => {
    if (!canSubmit) return;
    try {
      await createAgent.mutateAsync({
        name: trimmedName,
        workspace: workspaceFromName(trimmedName),
        model: trimmedModel || undefined,
      });
      toast.success(`Created agent ${trimmedName}`);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create agent', {
        duration: 10000,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Stands up a new agent on your machine. You can route channels to it after it is created.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              value={name}
              maxLength={64}
              placeholder="research"
              onChange={e => setName(e.target.value)}
              autoFocus
            />
            {trimmedName.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Workspace: {workspaceFromName(trimmedName)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-model">Model (optional)</Label>
            <Input
              id="agent-model"
              value={model}
              maxLength={256}
              placeholder="Leave blank to use the default model"
              onChange={e => setModel(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={createAgent.isPending}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {createAgent.isPending ? (
              <>
                Creating
                <AnimatedDots />
              </>
            ) : (
              'Create agent'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
