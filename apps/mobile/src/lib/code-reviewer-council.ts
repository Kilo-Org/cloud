import {
  COUNCIL_MAX_REQUIRED_LABELS,
  COUNCIL_MIN_SPECIALISTS,
  COUNCIL_REQUIRED_LABEL_MAX_LENGTH,
  type CouncilAggregationStrategy,
} from '@kilocode/app-shared/code-review';

// Literal keys, never a template: the catalog check scans the source for the
// keys a lookup passes on, and a computed key is invisible to it.
const SPECIALIST_COPY = [
  {
    // The focus-area label already names this concern, and the catalog keeps
    // one wording per identical English string.
    id: 'security',
    nameKey: 'codeReviewer.focusArea.security',
    descriptionKey: 'codeReviewer.council.specialist.security',
  },
  {
    id: 'performance',
    nameKey: 'common.performance',
    descriptionKey: 'codeReviewer.council.specialist.performance',
  },
  {
    id: 'testing',
    nameKey: 'codeReviewer.council.specialistName.testCoverage',
    descriptionKey: 'codeReviewer.council.specialist.testing',
  },
  {
    id: 'correctness',
    nameKey: 'codeReviewer.council.specialistName.correctness',
    descriptionKey: 'codeReviewer.council.specialist.correctness',
  },
];

const CUSTOM_SPECIALIST_COPY = {
  nameKey: 'codeReviewer.council.specialistName.custom',
  descriptionKey: 'codeReviewer.council.specialist.custom',
};

/** The copy one council specialist preset renders: its name and its lens. */
export type SpecialistCopy = typeof CUSTOM_SPECIALIST_COPY;

/**
 * The catalog keys a specialist id renders. A custom specialist the server
 * stored (no preset) falls back to the generic name and lens.
 */
export function specialistCopy(id: string): SpecialistCopy {
  return SPECIALIST_COPY.find(entry => entry.id === id) ?? CUSTOM_SPECIALIST_COPY;
}

/** What the council route paints. */
export type CouncilSurface = 'loading' | 'unavailable' | 'editor';

/**
 * Decides the council route's body. A platform that has no council is a
 * refusal on the same footing as an unentitled organization: the org PATCH
 * drops council fields for it, so an editor opened there could not persist what
 * it showed, whatever the entitlement read says.
 */
export function councilSurface(input: {
  pending: boolean;
  allowed: boolean;
  platformSupportsCouncil: boolean;
}): CouncilSurface {
  if (!input.platformSupportsCouncil) {
    return 'unavailable';
  }
  if (input.pending) {
    return 'loading';
  }
  return input.allowed ? 'editor' : 'unavailable';
}

/**
 * Whether turning a specialist off would leave a council that is switched on
 * with fewer voters than it needs. `isCouncilActive` requires the minimum, so
 * persisting that state would store `enabled: true` on a council that never
 * runs: the switch would read on while every repository got a plain review.
 * The web form blocks the equivalent save.
 */
export function wouldStarveCouncil(
  council: Readonly<{
    enabled: boolean;
    specialists: readonly Readonly<{ id: string; enabled: boolean }>[];
  }>,
  specialistId: string,
  nextEnabled: boolean
): boolean {
  if (!council.enabled || nextEnabled) {
    return false;
  }
  const enabled = council.specialists.filter(specialist => specialist.enabled);
  if (!enabled.some(specialist => specialist.id === specialistId)) {
    return false;
  }
  return enabled.length - 1 < COUNCIL_MIN_SPECIALISTS;
}

export const STRATEGY_LABEL_KEYS = {
  advisory: 'codeReviewer.council.strategy.advisory',
  unanimous: 'codeReviewer.council.strategy.unanimous',
  majority: 'codeReviewer.council.strategy.majority',
} satisfies Record<CouncilAggregationStrategy, string>;

export const STRATEGY_DESCRIPTION_KEYS = {
  advisory: 'codeReviewer.council.strategy.advisoryDescription',
  unanimous: 'codeReviewer.council.strategy.unanimousDescription',
  majority: 'codeReviewer.council.strategy.majorityDescription',
} satisfies Record<CouncilAggregationStrategy, string>;

/** The server caps a label draft can exceed, in the order the form checks them. */
export type RequiredLabelsProblem = 'tooMany' | 'tooLong';

export type RequiredLabels =
  | { ok: true; labels: string[] }
  | { ok: false; problem: RequiredLabelsProblem };

/**
 * Parses the comma-separated label field into the persisted list: trimmed and
 * deduped case-insensitively (the server matches labels regardless of case, so
 * two casings would be one gate twice).
 *
 * A draft past either server cap is refused rather than cut down: a silently
 * shorter list would save a gate the user did not write, so the screen keeps
 * the draft and shows why the save did not happen — what the web form does.
 */
export function parseRequiredLabels(value: string): RequiredLabels {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of value.split(',')) {
    const label = raw.trim();
    if (label.length === 0) {
      continue;
    }
    const key = label.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    labels.push(label);
  }
  if (labels.length > COUNCIL_MAX_REQUIRED_LABELS) {
    return { ok: false, problem: 'tooMany' };
  }
  if (labels.some(label => label.length > COUNCIL_REQUIRED_LABEL_MAX_LENGTH)) {
    return { ok: false, problem: 'tooLong' };
  }
  return { ok: true, labels };
}
