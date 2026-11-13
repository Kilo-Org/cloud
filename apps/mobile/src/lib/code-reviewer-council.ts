import {
  COUNCIL_MAX_REQUIRED_LABELS,
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

/**
 * Parses the comma-separated label field into the persisted list: trimmed,
 * length-capped, deduped case-insensitively (the server matches labels
 * regardless of case, so two casings would be one gate twice) and bounded to
 * the server's own maximum.
 */
export function parseRequiredLabels(value: string): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const raw of value.split(',')) {
    const label = raw.trim();
    const key = label.toLowerCase();
    const usable =
      label.length > 0 &&
      label.length <= COUNCIL_REQUIRED_LABEL_MAX_LENGTH &&
      !seen.has(key) &&
      labels.length < COUNCIL_MAX_REQUIRED_LABELS;
    if (usable) {
      seen.add(key);
      labels.push(label);
    }
  }
  return labels;
}
