// Ported from packages/db/src/schema-types.ts's CodeReviewAgentConfigSchema
// (review_style, gate_threshold z.enums) and apps/web/src/components/code-reviews/ReviewConfigForm.tsx's
// FOCUS_AREAS ids. Values must stay in sync with the db zod schema — see
// packages/db/src/schema-types.ts.
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
