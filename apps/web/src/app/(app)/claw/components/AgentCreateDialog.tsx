'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { AnimatedDots } from './AnimatedDots';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
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
import { useClawModelOptions } from '../hooks/useClawModelOptions';
import { addKilocodeModelPrefix } from './modelSupport';

// Mirror of the controller's normalizeAgentId (openclaw-agent-config.ts) so the
// derived workspace is 1:1 with the agent id the controller will assign. Using
// the controller's exact charset (underscores preserved, not collapsed to '-')
// is what keeps distinct agents like `foo_bar` and `foo-bar` from sharing a
// workspace directory.
function normalizeAgentId(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'main';
  const lower = trimmed.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return lower;
  return (
    lower
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 64) || 'main'
  );
}

// Derive a stable, unix-safe workspace path from the agent name so users never
// have to type a machine path. Keyed on the normalized agent id for uniqueness.
function workspaceFromName(name: string): string {
  return `/root/.openclaw/workspace-${normalizeAgentId(name)}`;
}

export function AgentCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { createAgent } = useClawAgentMutations();
  const { modelOptions, isLoading: isLoadingModels, error: modelError } = useClawModelOptions();
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
        // The combobox yields a bare catalog id; agent model refs are stored
        // under the kilocode/ namespace.
        model: trimmedModel ? addKilocodeModelPrefix(trimmedModel) : undefined,
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
            <Label>Model (optional)</Label>
            <ModelCombobox
              label=""
              models={modelOptions}
              value={model}
              onValueChange={setModel}
              isLoading={isLoadingModels}
              error={modelError}
              placeholder="Use the default model"
              modal
              className="w-full"
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
