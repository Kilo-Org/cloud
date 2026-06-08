'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { AnimatedDots } from './AnimatedDots';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AgentUpdateInput } from '@/lib/kiloclaw/agent-schemas';
import type { AgentSummary } from '@/lib/kiloclaw/types';
import { useClawAgentMutations } from '../hooks/useClawHooks';
import { useClawModelOptions } from '../hooks/useClawModelOptions';

const INHERIT = 'inherit';
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max'] as const;
const VERBOSE = ['off', 'on', 'full'] as const;
const REASONING = ['on', 'off', 'stream'] as const;

type ThinkingOpt = typeof INHERIT | (typeof THINKING)[number];
type VerboseOpt = typeof INHERIT | (typeof VERBOSE)[number];
type ReasoningOpt = typeof INHERIT | (typeof REASONING)[number];
type FastModeOpt = typeof INHERIT | 'on' | 'off';

// The agent's OWN model (not the inherited/effective one): primary + fallbacks.
function ownModel(agent: AgentSummary): { primary: string; fallbacks: string[] } {
  const raw = agent.rawModel;
  if (typeof raw === 'string') return { primary: raw, fallbacks: [] };
  if (raw && typeof raw === 'object') {
    return { primary: raw.primary ?? '', fallbacks: raw.fallbacks ?? [] };
  }
  return { primary: '', fallbacks: [] };
}

function LabeledSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={v => onChange(v as T)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>Inherit default</SelectItem>
          {options.map(opt => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function AgentEditDialog({
  open,
  onOpenChange,
  agent,
  etag,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentSummary;
  etag: string;
}) {
  const { updateAgent } = useClawAgentMutations();
  const { modelOptions, isLoading: isLoadingModels } = useClawModelOptions();

  const initial = useMemo(() => ownModel(agent), [agent]);
  // An agent owns a model when rawModel is set — including a fallback-only model
  // (no primary). The inherit toggle is the only way to clear such a model.
  const hadOwnModel = agent.rawModel != null;
  const [inheritModel, setInheritModel] = useState(!hadOwnModel);
  const [primary, setPrimary] = useState(initial.primary);
  const [thinking, setThinking] = useState<ThinkingOpt>(
    (agent.settings.thinkingDefault as ThinkingOpt | null) ?? INHERIT
  );
  const [verbose, setVerbose] = useState<VerboseOpt>(
    (agent.settings.verboseDefault as VerboseOpt | null) ?? INHERIT
  );
  const [reasoning, setReasoning] = useState<ReasoningOpt>(
    (agent.settings.reasoningDefault as ReasoningOpt | null) ?? INHERIT
  );
  const [fastMode, setFastMode] = useState<FastModeOpt>(
    agent.settings.fastModeDefault === null
      ? INHERIT
      : agent.settings.fastModeDefault
        ? 'on'
        : 'off'
  );

  // Diff the form against the agent's current values into a controller patch.
  const patch = useMemo(() => {
    const set: AgentUpdateInput['set'] = {};
    const unset: AgentUpdateInput['unset'] = [];

    if (inheritModel) {
      // Clear the agent's own model (primary-only OR fallback-only) so it falls
      // back to the fleet default.
      if (hadOwnModel) unset.push('model');
    } else {
      const newPrimary = primary.trim();
      const fallbacks = initial.fallbacks; // preserved; not edited here
      const changed = !hadOwnModel || newPrimary !== initial.primary;
      if (changed && (newPrimary !== '' || fallbacks.length > 0)) {
        set.model = {
          ...(newPrimary !== '' ? { primary: newPrimary } : {}),
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
        };
      }
    }

    if (thinking === INHERIT) {
      if (agent.settings.thinkingDefault !== null) unset.push('thinkingDefault');
    } else if (thinking !== agent.settings.thinkingDefault) {
      set.thinkingDefault = thinking;
    }

    if (verbose === INHERIT) {
      if (agent.settings.verboseDefault !== null) unset.push('verboseDefault');
    } else if (verbose !== agent.settings.verboseDefault) {
      set.verboseDefault = verbose;
    }

    if (reasoning === INHERIT) {
      if (agent.settings.reasoningDefault !== null) unset.push('reasoningDefault');
    } else if (reasoning !== agent.settings.reasoningDefault) {
      set.reasoningDefault = reasoning;
    }

    if (fastMode === INHERIT) {
      if (agent.settings.fastModeDefault !== null) unset.push('fastModeDefault');
    } else {
      const next = fastMode === 'on';
      if (next !== agent.settings.fastModeDefault) set.fastModeDefault = next;
    }

    return { set, unset };
  }, [
    inheritModel,
    hadOwnModel,
    primary,
    thinking,
    verbose,
    reasoning,
    fastMode,
    initial,
    agent.settings,
  ]);

  // Not inheriting but no primary and no fallbacks = no model to write.
  const modelInvalid = !inheritModel && primary.trim() === '' && initial.fallbacks.length === 0;
  const hasChanges = Object.keys(patch.set).length > 0 || patch.unset.length > 0;
  const canSubmit = hasChanges && !modelInvalid && !updateAgent.isPending;

  const onSubmit = async () => {
    if (!canSubmit) return;
    try {
      await updateAgent.mutateAsync(agent.id, { etag, set: patch.set, unset: patch.unset });
      toast.success(`Updated ${agent.name ?? agent.id}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update agent', {
        duration: 10000,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={updateAgent.isPending ? undefined : onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {agent.name ?? agent.id}</DialogTitle>
          <DialogDescription>
            Model and behavior for this agent. Leave a field on “Inherit default” to use the
            fleet-wide setting.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Model</Label>
            <div className="flex items-center gap-2">
              <Checkbox
                id="agent-edit-inherit-model"
                checked={inheritModel}
                onCheckedChange={checked => setInheritModel(checked === true)}
              />
              <Label
                htmlFor="agent-edit-inherit-model"
                className="text-muted-foreground font-normal"
              >
                Use the default model
              </Label>
            </div>
            {!inheritModel && (
              <>
                <ModelCombobox
                  label=""
                  models={modelOptions}
                  value={primary}
                  onValueChange={setPrimary}
                  isLoading={isLoadingModels}
                  placeholder="Select a model"
                  modal
                  className="w-full"
                />
                {initial.fallbacks.length > 0 && (
                  <p className="text-muted-foreground text-xs">
                    Fallbacks preserved: {initial.fallbacks.join(', ')}
                  </p>
                )}
                {modelInvalid && (
                  <p className="text-destructive text-xs">
                    Enter a model id, or use the default model.
                  </p>
                )}
              </>
            )}
          </div>

          <LabeledSelect
            label="Thinking"
            value={thinking}
            options={THINKING}
            onChange={setThinking}
          />
          <LabeledSelect label="Verbose" value={verbose} options={VERBOSE} onChange={setVerbose} />
          <LabeledSelect
            label="Reasoning"
            value={reasoning}
            options={REASONING}
            onChange={setReasoning}
          />
          <LabeledSelect
            label="Fast mode"
            value={fastMode}
            options={['on', 'off'] as const}
            onChange={setFastMode}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateAgent.isPending}
          >
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {updateAgent.isPending ? (
              <>
                Saving
                <AnimatedDots />
              </>
            ) : (
              'Save changes'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
