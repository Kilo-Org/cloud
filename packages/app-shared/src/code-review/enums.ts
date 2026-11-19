// Review configuration enums for the code-review agent. This module is the
// single declaration: packages/db's CodeReviewAgentConfigSchema imports
// REVIEW_STYLES and GATE_THRESHOLDS from here for its review_style and
// gate_threshold columns, and REVIEW_FOCUS_AREAS holds the focus-area ids the
// web and mobile forms offer.
//
// Note: the db schema does NOT constrain focus_areas to an enum (it's
// `z.array(z.string())`, deliberately permissive). REVIEW_FOCUS_AREAS here
// matches the *UI-level* constraint that both apps' forms currently enforce,
// not a db-level one.
export const REVIEW_STYLES = ['strict', 'balanced', 'lenient', 'roast'] as const;
export type ReviewStyle = (typeof REVIEW_STYLES)[number];

export const REVIEW_FOCUS_AREAS = [
  'security',
  'performance',
  'bugs',
  'style',
  'testing',
  'documentation',
] as const;
export type ReviewFocusArea = (typeof REVIEW_FOCUS_AREAS)[number];

export const GATE_THRESHOLDS = ['off', 'all', 'warning', 'critical'] as const;
export type GateThreshold = (typeof GATE_THRESHOLDS)[number];

// Canonical platform list — packages/db re-exports this (schema-types.ts),
// same direction as REVIEW_STYLES / GATE_THRESHOLDS above.
export const CODE_REVIEW_PLATFORMS = ['github', 'gitlab', 'bitbucket'] as const;
export type CodeReviewPlatform = (typeof CODE_REVIEW_PLATFORMS)[number];
