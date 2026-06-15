'use client';

import { useId, useMemo, useState } from 'react';
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
  THINKING_OPTIONS,
  VERBOSE_OPTIONS,
  type AgentDefaultsUpdateInput,
} from '@/lib/kiloclaw/agent-schemas';
import type { AgentDefaultsSummary } from '@/lib/kiloclaw/types';

import { reconcileAmbiguousMutation, useClawAgentMutations } from '../hooks/useClawHooks';
import { useClawModelOptions } from '../hooks/useClawModelOptions';
import { addKilocodeModelPrefix, stripKilocodeModelPrefix } from './modelSupport';

// At the defaults tier there is nothing to inherit FROM, so the empty option
// clears the default (OpenClaw falls back to its own built-in) rather than
// "inherit". Defaults only expose model + thinking + verbose (the controller
// rejects reasoning/fastMode at this tier).
const UNSET = 'unset';

type ThinkingOpt = typeof UNSET | (typeof THINKING_OPTIONS)[number];
type VerboseOpt = typeof UNSET | (typeof VERBOSE_OPTIONS)[number];

function toOption<T extends string>(raw: string | null, options: readonly T[]): typeof UNSET | T {
  return options.find(opt => opt === raw) ?? UNSET;
}

const HINTS = {
  model: 'The model every agent uses unless it sets its own. Uncheck to leave it unset.',
  thinking:
    'Default reasoning effort for agents that don’t set their own. Not set = OpenClaw’s built-in.',
  verbose: 'Default tool-activity output for agents that don’t set their own.',
};

function DefaultSelect<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  const isValue = (v: string): v is T => v === UNSET || options.some(opt => opt === v);
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const hintId = `${baseId}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={triggerId}>{label}</Label>
      <p id={hintId} className="text-muted-foreground text-xs">
        {hint}
      </p>
      <Select
        value={value}
        onValueChange={v => {
          if (isValue(v)) onChange(v);
        }}
      >
        <SelectTrigger id={triggerId} aria-describedby={hintId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>Not set</SelectItem>
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

/**
 * Edits the inherited defaults (model + thinking + verbose) that every agent
 * inherits unless it sets its own. Shares the config-wide etag with the list.
 */
export function AgentDefaultsDialog({
  open,
  onOpenChange,
  defaults,
  etag,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaults: AgentDefaultsSummary;
  etag: string;
  // Called after a successful save — defaults edits don't hot-reload, so the
  // caller tracks a pending-restart count.
  onApplied: () => void;
}) {
  const { updateDefaults, refetchAgents } = useClawAgentMutations();
  const { modelOptions, isLoading: isLoadingModels, error: modelError } = useClawModelOptions();

  const initial = useMemo(
    (): {
      hasModel: boolean;
      primary: string;
      fallbacks: string[];
      thinking: ThinkingOpt;
      verbose: VerboseOpt;
    } => ({
      hasModel: defaults.model != null,
      primary: stripKilocodeModelPrefix(defaults.model?.primary ?? ''),
      fallbacks: defaults.model?.fallbacks ?? [],
      thinking: toOption(defaults.settings.thinkingDefault, THINKING_OPTIONS),
      verbose: toOption(defaults.settings.verboseDefault, VERBOSE_OPTIONS),
    }),
    [defaults]
  );

  const [setModel, setSetModel] = useState(initial.hasModel);
  const [primary, setPrimary] = useState(initial.primary);
  const [thinking, setThinking] = useState<ThinkingOpt>(initial.thinking);
  const [verbose, setVerbose] = useState<VerboseOpt>(initial.verbose);

  // "Set a default model" with no primary and no preserved fallbacks = nothing to write.
  const modelInvalid = setModel && primary.trim() === '' && initial.fallbacks.length === 0;

  const patch = useMemo(() => {
    const set: AgentDefaultsUpdateInput['set'] = {};
    const unset: AgentDefaultsUpdateInput['unset'] = [];

    if (!setModel) {
      // Clear the default model so OpenClaw picks (primary-only OR fallback-only).
      if (initial.hasModel) unset.push('model');
    } else {
      const newPrimary = primary.trim();
      const fallbacks = initial.fallbacks; // preserved; not edited here
      const changed = !initial.hasModel || newPrimary !== initial.primary;
      if (changed && (newPrimary !== '' || fallbacks.length > 0)) {
        set.model = {
          ...(newPrimary !== '' ? { primary: addKilocodeModelPrefix(newPrimary) } : {}),
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
        };
      }
    }

    if (thinking !== initial.thinking) {
      if (thinking === UNSET) unset.push('thinkingDefault');
      else set.thinkingDefault = thinking;
    }
    if (verbose !== initial.verbose) {
      if (verbose === UNSET) unset.push('verboseDefault');
      else set.verboseDefault = verbose;
    }

    return { set, unset };
  }, [setModel, primary, thinking, verbose, initial]);

  const hasChanges = Object.keys(patch.set).length > 0 || patch.unset.length > 0;
  const canSubmit = hasChanges && !modelInvalid && !updateDefaults.isPending;

  // Does a refetched defaults snapshot reflect the patch we tried to write?
  // The whole requested model shape must match: a fallback-only write (no
  // primary) would otherwise pass trivially against any snapshot, so compare the
  // primary AND exact fallback array for every field the patch actually set.
  const defaultsApplied = (d: AgentDefaultsSummary): boolean => {
    const { set, unset } = patch;
    if (set.model !== undefined) {
      if (d.model == null) return false;
      if (set.model.primary !== undefined && d.model.primary !== set.model.primary) return false;
      if (set.model.fallbacks !== undefined) {
        const want = set.model.fallbacks;
        const got = d.model.fallbacks;
        if (got.length !== want.length) return false;
        if (want.some((f, i) => got[i] !== f)) return false;
      }
    }
    if (set.thinkingDefault !== undefined && d.settings.thinkingDefault !== set.thinkingDefault)
      return false;
    if (set.verboseDefault !== undefined && d.settings.verboseDefault !== set.verboseDefault)
      return false;
    for (const k of unset) {
      if (k === 'model' && d.model != null) return false;
      if (k === 'thinkingDefault' && d.settings.thinkingDefault != null) return false;
      if (k === 'verboseDefault' && d.settings.verboseDefault != null) return false;
    }
    return true;
  };

  const onSubmit = async () => {
    if (!canSubmit) return;
    try {
      await updateDefaults.mutateAsync({ etag, set: patch.set, unset: patch.unset });
      onApplied();
      toast.success('Updated defaults');
      onOpenChange(false);
    } catch (err) {
      // The update can time out AFTER the controller committed it; reconcile
      // against the intended defaults before reporting failure.
      const applied = await reconcileAmbiguousMutation(err, refetchAgents, list =>
        defaultsApplied(list.defaults)
      );
      if (applied) {
        onApplied();
        toast.success('Updated defaults');
        onOpenChange(false);
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Failed to update defaults', {
        duration: 10000,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={updateDefaults.isPending ? undefined : onOpenChange}>
      {/* Cap height and scroll the body so the always-visible helper text can't
          push the footer off-screen on short viewports / large text settings. */}
      <DialogContent className="grid max-h-[85vh] max-w-md grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>Inherited defaults</DialogTitle>
          <DialogDescription>
            The model and behavior every agent inherits unless it sets its own.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <div className="flex flex-col gap-2">
            <Label>Model</Label>
            <p className="text-muted-foreground text-xs">{HINTS.model}</p>
            <div className="flex items-center gap-2">
              <Checkbox
                id="agent-defaults-set-model"
                checked={setModel}
                onCheckedChange={checked => setSetModel(checked === true)}
              />
              <Label
                htmlFor="agent-defaults-set-model"
                className="text-muted-foreground font-normal"
              >
                Set a default model
              </Label>
            </div>
            {setModel && (
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
                    Pick a model, or uncheck to leave the default unset.
                  </p>
                )}
              </>
            )}
          </div>

          <DefaultSelect
            label="Thinking"
            hint={HINTS.thinking}
            value={thinking}
            options={THINKING_OPTIONS}
            onChange={setThinking}
          />
          <DefaultSelect
            label="Verbose"
            hint={HINTS.verbose}
            value={verbose}
            options={VERBOSE_OPTIONS}
            onChange={setVerbose}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateDefaults.isPending}
          >
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {updateDefaults.isPending ? (
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
