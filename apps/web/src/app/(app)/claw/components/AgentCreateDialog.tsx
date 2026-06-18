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
import { workspaceFromName } from '@/lib/kiloclaw/agent-id';
import { reconcileAmbiguousMutation, useClawAgentMutations } from '../hooks/useClawHooks';
import { useClawModelOptions } from '../hooks/useClawModelOptions';
import { addKilocodeModelPrefix } from './modelSupport';

export function AgentCreateDialog({
  open,
  onOpenChange,
  existingIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Agent ids that exist BEFORE this create, so the timeout-reconcile can't
  // mistake a pre-existing agent (name conflict, reserved `main`) for success.
  existingIds: string[];
}) {
  const { createAgent, refetchAgents } = useClawAgentMutations();
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
      // Create can time out at the gateway after the controller already made the
      // agent (fire-and-forget). Reconcile by matching the agent's VERBATIM name
      // (the controller stores the submitted name as agents.list[].name) among
      // agents that did NOT exist before submit — so we don't have to predict the
      // normalized id and the reconcile doesn't depend on the id-normalization
      // mirror staying in lockstep with the controller. A deterministic conflict
      // (`agent_exists`) or reserved `main` won't match (no new id) and surfaces
      // as the real error.
      //
      // Residual race we accept: if THIS request is lost before reaching the
      // controller while a concurrent writer creates an agent with the same name,
      // the refetch can match it. Narrow (same name, simultaneous, request lost
      // pre-controller) and self-correcting on the next list view.
      const applied = await reconcileAmbiguousMutation(err, refetchAgents, list =>
        list.agents.some(a => a.name === trimmedName && !existingIds.includes(a.id))
      );
      if (applied) {
        toast.success(`Created agent ${trimmedName} (took a moment)`);
        reset();
        onOpenChange(false);
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Failed to create agent', {
        duration: 10000,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      {/* Cap height and scroll the body so the footer stays on-screen on short
          viewports / large text settings. */}
      <DialogContent className="grid max-h-[85vh] max-w-md grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>Create agent</DialogTitle>
          <DialogDescription>
            Stands up a new agent on your machine. You can route channels to it after it is created.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
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
                Workspace: <span className="font-mono">{workspaceFromName(trimmedName)}</span>
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

          <p className="text-muted-foreground text-xs">
            Creating an agent can take up to a minute.
          </p>
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
