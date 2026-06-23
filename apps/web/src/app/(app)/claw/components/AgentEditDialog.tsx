'use client';

import { useId, useMemo, useState } from 'react';
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
import type { AgentSettingsSummary, AgentSummary } from '@/lib/kiloclaw/types';
import { reconcileAmbiguousMutation, useClawAgentMutations } from '../hooks/useClawHooks';

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

function LabeledSelect<T extends string>({
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
  // Radix's onValueChange hands back a plain string. Narrow it to a known value
  // (INHERIT, which is always rendered, or one of the options) before calling
  // onChange instead of casting, so an unexpected value can't reach the patch.
  const isValue = (v: string): v is T => v === INHERIT || options.some(opt => opt === v);
  // Visible helper text wired via aria-describedby — the documented forms
  // convention (interaction-design.md), not a hover-only tooltip.
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

// Plain-language explanations of the OpenClaw per-agent behavior knobs. These map
// to config that isn't surfaced on the main Settings page.
const HINTS = {
  thinking:
    'Reasoning effort before replying — higher helps on hard tasks but is slower. adaptive varies per task; max is the most.',
  reasoning:
    'Whether the model’s thinking is shown (separate from how much it thinks). on = a separate “Reasoning:” message; stream = Telegram only.',
  verbose:
    'Whether the agent posts its tool activity to the channel. on = a note when each tool starts; full = also its output.',
  fastMode: 'Optimizes for responsiveness. Separate knob from Thinking.',
} as const;

/**
 * Advanced per-agent behavior overrides (thinking / reasoning / verbose / fast
 * mode). Model and channels are edited inline on the agent row, so this dialog
 * holds only the rarely-touched advanced knobs.
 */
export function AgentEditDialog({
  open,
  onOpenChange,
  agent,
  etag,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentSummary;
  etag: string;
  // Called after a successful save — settings edits don't hot-reload, so the
  // caller tracks a pending-restart count.
  onApplied: () => void;
}) {
  const { updateAgent, refetchAgents } = useClawAgentMutations();

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

  const [thinking, setThinking] = useState<ThinkingOpt>(initialSettings.thinking);
  const [verbose, setVerbose] = useState<VerboseOpt>(initialSettings.verbose);
  const [reasoning, setReasoning] = useState<ReasoningOpt>(initialSettings.reasoning);
  const [fastMode, setFastMode] = useState<FastModeOpt>(initialSettings.fastMode);

  // Diff the form against the initial values into a controller patch. Only emit a
  // change when it differs from its initial select value, so an untouched (incl.
  // unknown forward-compat) value never produces a spurious unset.
  const patch = useMemo(() => {
    const set: AgentUpdateInput['set'] = {};
    const unset: AgentUpdateInput['unset'] = [];
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
  }, [thinking, verbose, reasoning, fastMode, initialSettings]);

  const hasChanges = Object.keys(patch.set).length > 0 || patch.unset.length > 0;
  const canSubmit = hasChanges && !updateAgent.isPending;

  // Does a refetched settings snapshot reflect the patch we tried to write?
  const settingsApplied = (s: AgentSettingsSummary): boolean => {
    const { set, unset } = patch;
    if (set.thinkingDefault !== undefined && s.thinkingDefault !== set.thinkingDefault)
      return false;
    if (set.verboseDefault !== undefined && s.verboseDefault !== set.verboseDefault) return false;
    if (set.reasoningDefault !== undefined && s.reasoningDefault !== set.reasoningDefault)
      return false;
    if (set.fastModeDefault !== undefined && s.fastModeDefault !== set.fastModeDefault)
      return false;
    for (const k of unset) {
      if (k === 'thinkingDefault' && s.thinkingDefault != null) return false;
      if (k === 'verboseDefault' && s.verboseDefault != null) return false;
      if (k === 'reasoningDefault' && s.reasoningDefault != null) return false;
      if (k === 'fastModeDefault' && s.fastModeDefault != null) return false;
    }
    return true;
  };

  const onSubmit = async () => {
    if (!canSubmit) return;
    try {
      await updateAgent.mutateAsync(agent.id, { etag, set: patch.set, unset: patch.unset });
      onApplied();
      toast.success(`Updated ${agent.name ?? agent.id}`);
      onOpenChange(false);
    } catch (err) {
      // The update can time out AFTER the controller committed it; reconcile
      // against the intended settings before reporting failure.
      const applied = await reconcileAmbiguousMutation(err, refetchAgents, list => {
        const a = list.agents.find(x => x.id === agent.id);
        return a !== undefined && settingsApplied(a.settings);
      });
      if (applied) {
        onApplied();
        toast.success(`Updated ${agent.name ?? agent.id}`);
        onOpenChange(false);
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Failed to update agent', {
        duration: 10000,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={updateAgent.isPending ? undefined : onOpenChange}>
      {/* Cap height and scroll the body so the always-visible helper text can't
          push the footer off-screen on short viewports / large text settings. */}
      <DialogContent className="grid max-h-[85vh] max-w-md grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>Advanced settings · {agent.name ?? agent.id}</DialogTitle>
          <DialogDescription>
            Behavior overrides for this agent. Leave a field on “Inherit default” to use the
            inherited default. Model and channels are edited on the agent’s row.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          <LabeledSelect
            label="Thinking"
            hint={HINTS.thinking}
            value={thinking}
            options={THINKING_OPTIONS}
            onChange={setThinking}
          />
          <LabeledSelect
            label="Reasoning"
            hint={HINTS.reasoning}
            value={reasoning}
            options={REASONING_OPTIONS}
            onChange={setReasoning}
          />
          <LabeledSelect
            label="Verbose"
            hint={HINTS.verbose}
            value={verbose}
            options={VERBOSE_OPTIONS}
            onChange={setVerbose}
          />
          <LabeledSelect
            label="Fast mode"
            hint={HINTS.fastMode}
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
