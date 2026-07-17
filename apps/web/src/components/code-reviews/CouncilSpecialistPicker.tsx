'use client';

import { useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ModelCombobox } from '@/components/shared/ModelCombobox';
import type { ModelOption } from '@/components/shared/model-combobox-options';
import { COUNCIL_SPECIALIST_PRESETS } from '@kilocode/worker-utils/code-review-council';
import type { CouncilSpecialistSelection } from '@/lib/code-reviews/core/council-selection';
import {
  getAvailableThinkingEfforts,
  thinkingEffortLabel,
} from '@/lib/code-reviews/core/model-variants';

const DEFAULT_EFFORT_VALUE = '__default__';

type CouncilSpecialistPickerProps = {
  selections: Record<string, CouncilSpecialistSelection>;
  onChange: (next: Record<string, CouncilSpecialistSelection>) => void;
  modelOptions: ModelOption[];
  isLoadingModels?: boolean;
  disabled?: boolean;
  /** Pass true when rendered inside a Radix Dialog so the model popover scrolls. */
  modal?: boolean;
  /**
   * The review's default model slug. Used so a specialist left on the default model can
   * still choose a thinking effort (effort options are model-specific).
   */
  defaultModelSlug?: string | null;
};

/**
 * The council specialist picker: each specialist can be enabled and given its OWN model
 * and thinking effort. Leaving the model unset means "use the review's default model".
 */
export function CouncilSpecialistPicker({
  selections,
  onChange,
  modelOptions,
  isLoadingModels,
  disabled,
  modal,
  defaultModelSlug,
}: CouncilSpecialistPickerProps) {
  const update = (id: string, patch: Partial<CouncilSpecialistSelection>) => {
    const current = selections[id] ?? {
      enabled: false,
      modelSlug: null,
      thinkingEffort: null,
    };
    onChange({ ...selections, [id]: { ...current, ...patch } });
  };

  // Prune any specialist's thinking effort once it's no longer valid for its effective model
  // — e.g. when the review's default model changes and a specialist left on the default now
  // has a different (or empty) effort set. Without this, a stale/invalid effort would stay in
  // state and be submitted as a runtime-agent variant. Skipped while models load (effort sets
  // can be transiently empty). Converges: the pruned state produces no further change.
  useEffect(() => {
    if (isLoadingModels) return;
    let changed = false;
    const next: Record<string, CouncilSpecialistSelection> = {};
    for (const [id, selection] of Object.entries(selections)) {
      const effortModel = selection.modelSlug ?? defaultModelSlug ?? null;
      const validEfforts = effortModel ? getAvailableThinkingEfforts(effortModel) : [];
      if (selection.thinkingEffort && !validEfforts.includes(selection.thinkingEffort)) {
        next[id] = { ...selection, thinkingEffort: null };
        changed = true;
      } else {
        next[id] = selection;
      }
    }
    if (changed) onChange(next);
  }, [selections, defaultModelSlug, isLoadingModels, onChange]);

  return (
    <div className="space-y-3">
      {COUNCIL_SPECIALIST_PRESETS.map(preset => {
        const selection = selections[preset.id] ?? {
          enabled: false,
          modelSlug: null,
          thinkingEffort: null,
        };
        // Effort options follow the specialist's own model, or the review's default
        // model when the specialist is left on the default.
        const effortModel = selection.modelSlug ?? defaultModelSlug ?? null;
        const variants = effortModel ? getAvailableThinkingEfforts(effortModel) : [];

        return (
          <div key={preset.id} className="space-y-3 rounded-md border p-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id={`council-specialist-${preset.id}`}
                checked={selection.enabled}
                disabled={disabled}
                onCheckedChange={() => update(preset.id, { enabled: !selection.enabled })}
                className="mt-1"
              />
              <div className="grid flex-1 gap-1 leading-none">
                <Label
                  htmlFor={`council-specialist-${preset.id}`}
                  className="cursor-pointer font-medium"
                >
                  {preset.name}
                </Label>
                <p className="text-muted-foreground text-sm">{preset.lens}</p>
              </div>
            </div>

            {selection.enabled && (
              <div className="grid gap-3 pl-7 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-muted-foreground text-xs">Model</Label>
                  <ModelCombobox
                    models={modelOptions}
                    isLoading={isLoadingModels}
                    value={selection.modelSlug ?? undefined}
                    // Changing the model clears the effort, since valid efforts are model-specific.
                    onValueChange={value =>
                      update(preset.id, {
                        modelSlug: value || null,
                        thinkingEffort: null,
                      })
                    }
                    variant="compact"
                    modal={modal}
                    disabled={disabled}
                    placeholder="Default (review model)"
                  />
                  <p className="text-muted-foreground text-xs">
                    Uses the review&apos;s model if left unset.
                  </p>
                </div>

                {variants.length > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Thinking effort</Label>
                    <Select
                      value={selection.thinkingEffort ?? DEFAULT_EFFORT_VALUE}
                      disabled={disabled}
                      onValueChange={value =>
                        update(preset.id, {
                          thinkingEffort: value === DEFAULT_EFFORT_VALUE ? null : value,
                        })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_EFFORT_VALUE}>Default</SelectItem>
                        {variants.map(variant => (
                          <SelectItem key={variant} value={variant}>
                            {thinkingEffortLabel(variant)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
