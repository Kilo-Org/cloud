import type { CodeReviewCouncilConfig, CouncilSpecialist } from '@kilocode/db/schema-types';
import {
  COUNCIL_SPECIALIST_PRESETS,
  presetToSpecialist,
} from '@kilocode/worker-utils/code-review-council';

/**
 * UI state for the manual "New Job" council picker. This is web-only glue between the
 * shared specialist presets and the persisted `CodeReviewCouncilConfig`. The pure
 * decision/manifest logic and the presets live in `@kilocode/worker-utils/code-review-council`.
 */

/**
 * UI selection for a single specialist: whether it's enabled, plus its optional
 * per-specialist model + thinking effort. `null` model/effort means "use the review's
 * default model/effort".
 */
export type CouncilSpecialistSelection = {
  enabled: boolean;
  modelSlug: string | null;
  thinkingEffort: string | null;
};

/** All presets enabled on the review's default model/effort — the initial picker state. */
export function defaultCouncilSelections(): Record<string, CouncilSpecialistSelection> {
  return Object.fromEntries(
    COUNCIL_SPECIALIST_PRESETS.map(preset => [
      preset.id,
      { enabled: true, modelSlug: null, thinkingEffort: null },
    ])
  );
}

/**
 * Builds picker selections from a persisted council config: presets present in the config
 * carry their saved enabled state + per-specialist model/effort; presets absent from the
 * config are shown disabled.
 */
export function councilSelectionsFromConfig(
  council: CodeReviewCouncilConfig | null | undefined
): Record<string, CouncilSpecialistSelection> {
  const selections: Record<string, CouncilSpecialistSelection> = Object.fromEntries(
    COUNCIL_SPECIALIST_PRESETS.map(preset => [
      preset.id,
      { enabled: false, modelSlug: null, thinkingEffort: null },
    ])
  );
  if (!council) return defaultCouncilSelections();
  for (const specialist of council.specialists) {
    // Ignore ids that are not known presets (the manual picker is preset-based).
    if (!(specialist.id in selections)) continue;
    selections[specialist.id] = {
      enabled: specialist.enabled,
      modelSlug: specialist.model_slug ?? null,
      thinkingEffort: specialist.thinking_effort ?? null,
    };
  }
  return selections;
}

/** Number of currently-enabled specialists across the selection state. */
export function countEnabledSelections(
  selections: Record<string, CouncilSpecialistSelection>
): number {
  return Object.values(selections).filter(selection => selection.enabled).length;
}

/**
 * Converts picker selections into the persisted specialist list: only enabled presets,
 * each carrying its chosen per-specialist model/effort (omitted when left as default).
 */
export function buildCouncilSpecialists(
  selections: Record<string, CouncilSpecialistSelection>
): CouncilSpecialist[] {
  return COUNCIL_SPECIALIST_PRESETS.filter(preset => selections[preset.id]?.enabled).map(preset => {
    const selection = selections[preset.id];
    return {
      ...presetToSpecialist(preset),
      model_slug: selection.modelSlug ?? undefined,
      thinking_effort: selection.thinkingEffort ?? undefined,
    };
  });
}
