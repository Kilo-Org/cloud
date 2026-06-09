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
import {
  REASONING_OPTIONS,
  THINKING_OPTIONS,
  VERBOSE_OPTIONS,
  type AgentUpdateInput,
} from '@/lib/kiloclaw/agent-schemas';
import type { AgentSummary } from '@/lib/kiloclaw/types';
import { useClawAgentMutations } from '../hooks/useClawHooks';
import { useClawModelOptions } from '../hooks/useClawModelOptions';
import { addKilocodeModelPrefix, stripKilocodeModelPrefix } from './modelSupport';

const INHERIT = 'inherit';

type ThinkingOpt = typeof INHERIT | (typeof THINKING_OPTIONS)[number];
type VerboseOpt = typeof INHERIT | (typeof VERBOSE_OPTIONS)[number];
type ReasoningOpt = typeof INHERIT | (typeof REASONING_OPTIONS)[number];
type FastModeOpt = typeof INHERIT | 'on' | 'off';

// Map a controller-reported setting value (string | null) to a select option,
// matching against the known options rather than casting; anything unrecognized
// (including null) falls back to INHERIT.
function toOption<T extends string>(raw: string | null, options: readonly T[]): typeof INHERIT | T {
  return options.find(opt => opt === raw) ?? INHERIT;
}

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
  // Radix's onValueChange hands back a plain string. Narrow it to a known value
  // (INHERIT, which is always rendered, or one of the options) before calling
  // onChange instead of casting, so an unexpected value can't reach the patch.
  const isValue = (v: string): v is T => v === INHERIT || options.some(opt => opt === v);
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select
        value={value}
        onValueChange={v => {
          if (isValue(v)) onChange(v);
        }}
      >
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
  const { modelOptions, isLoading: isLoadingModels, error: modelError } = useClawModelOptions();

  // Work in bare (un-prefixed) model-id space so the combobox value matches the
  // catalog options; the kilocode/ prefix is re-added when writing.
  const initial = useMemo(() => {
    const own = ownModel(agent);
    return { primary: stripKilocodeModelPrefix(own.primary), fallbacks: own.fallbacks };
  }, [agent]);
  // Initial select values. toOption maps null OR an unknown (forward-compat)
  // value to INHERIT; we diff against THESE rather than the raw settings so an
  // unknown value left untouched is never mistaken for an explicit unset and
  // silently deleted on an unrelated save.
  const initialSettings = useMemo(
    (): {
      thinking: ThinkingOpt;
      verbose: VerboseOpt;
      reasoning: ReasoningOpt;
      fastMode: FastModeOpt;
    } => ({
      thinking: toOption(agent.settings.thinkingDefault, THINKING_OPTIONS),
      verbose: toOption(agent.settings.verboseDefault, VERBOSE_OPTIONS),
      reasoning: toOption(agent.settings.reasoningDefault, REASONING_OPTIONS),
      fastMode:
        agent.settings.fastModeDefault === null
          ? INHERIT
          : agent.settings.fastModeDefault
            ? 'on'
            : 'off',
    }),
    [agent.settings]
  );

  // An agent owns a model when rawModel is set — including a fallback-only model
  // (no primary). The inherit toggle is the only way to clear such a model.
  const hadOwnModel = agent.rawModel != null;
  const [inheritModel, setInheritModel] = useState(!hadOwnModel);
  const [primary, setPrimary] = useState(initial.primary);
  const [thinking, setThinking] = useState<ThinkingOpt>(initialSettings.thinking);
  const [verbose, setVerbose] = useState<VerboseOpt>(initialSettings.verbose);
  const [reasoning, setReasoning] = useState<ReasoningOpt>(initialSettings.reasoning);
  const [fastMode, setFastMode] = useState<FastModeOpt>(initialSettings.fastMode);

  // Diff the form against the initial values into a controller patch.
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
          ...(newPrimary !== '' ? { primary: addKilocodeModelPrefix(newPrimary) } : {}),
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
        };
      }
    }

    // Only emit a setting change when it differs from its initial select value,
    // so an untouched (incl. unknown) value never produces a spurious unset.
    if (thinking !== initialSettings.thinking) {
      if (thinking === INHERIT) unset.push('thinkingDefault');
      else set.thinkingDefault = thinking;
    }
    if (verbose !== initialSettings.verbose) {
      if (verbose === INHERIT) unset.push('verboseDefault');
      else set.verboseDefault = verbose;
    }
    if (reasoning !== initialSettings.reasoning) {
      if (reasoning === INHERIT) unset.push('reasoningDefault');
      else set.reasoningDefault = reasoning;
    }
    if (fastMode !== initialSettings.fastMode) {
      if (fastMode === INHERIT) unset.push('fastModeDefault');
      else set.fastModeDefault = fastMode === 'on';
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
    initialSettings,
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
                  error={modelError}
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
            options={THINKING_OPTIONS}
            onChange={setThinking}
          />
          <LabeledSelect
            label="Verbose"
            value={verbose}
            options={VERBOSE_OPTIONS}
            onChange={setVerbose}
          />
          <LabeledSelect
            label="Reasoning"
            value={reasoning}
            options={REASONING_OPTIONS}
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
