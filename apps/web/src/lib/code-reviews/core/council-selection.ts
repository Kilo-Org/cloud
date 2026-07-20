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

/**
 * PostHog flag that gates council UI visibility for entitled enterprise orgs (staged
 * rollout). Local development always shows the UI regardless of this flag.
 */
export const CODE_REVIEW_COUNCIL_FLAG = 'code-review-council';

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
 * Reverse of `buildCouncilSpecialists`: hydrates picker selections from a persisted council
 * config so an existing org config round-trips into the UI. Presets absent from the config are
 * disabled; present ones carry their saved per-specialist model/effort.
 */
export function councilSelectionsFromConfig(
  council: CodeReviewCouncilConfig | null | undefined
): Record<string, CouncilSpecialistSelection> {
  const byId = new Map((council?.specialists ?? []).map(specialist => [specialist.id, specialist]));
  return Object.fromEntries(
    COUNCIL_SPECIALIST_PRESETS.map(preset => {
      const saved = byId.get(preset.id);
      return [
        preset.id,
        {
          enabled: saved?.enabled ?? false,
          modelSlug: saved?.model_slug ?? null,
          thinkingEffort: saved?.thinking_effort ?? null,
        },
      ];
    })
  );
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
