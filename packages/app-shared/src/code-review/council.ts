// Council (enterprise multi-specialist review) values that a client renders.
//
// `packages/db` keeps the zod schemas and `@kilocode/worker-utils` keeps the
// dispatch logic, but the role list, the preset roster and the governance
// choices are plain data that the web form and the mobile config screen both
// paint. They live here so those two surfaces cannot drift, and the server
// packages re-export these names instead of declaring their own copies.
//
// Values must stay in sync with the persisted `CodeReviewCouncilConfigSchema`
// in packages/db/src/schema-types.ts.

export const COUNCIL_SPECIALIST_ROLES = [
  'security',
  'performance',
  'testing',
  'correctness',
  'docs',
  'custom',
] as const;
export type CouncilSpecialistRole = (typeof COUNCIL_SPECIALIST_ROLES)[number];

/** A preset the config UI offers as one enabled-by-default voting member. */
export type CouncilSpecialistPreset = {
  id: string;
  role: CouncilSpecialistRole;
  name: string;
  lens: string;
};

export const COUNCIL_SPECIALIST_PRESETS: CouncilSpecialistPreset[] = [
  {
    id: 'security',
    role: 'security',
    name: 'Security',
    lens: 'Injection, auth/authorization bypass, secret handling, unsafe deserialization, SSRF, and data exposure.',
  },
  {
    id: 'performance',
    role: 'performance',
    name: 'Performance',
    lens: 'Hot paths, N+1 queries, unnecessary allocations, blocking I/O, and algorithmic complexity regressions.',
  },
  {
    id: 'testing',
    role: 'testing',
    name: 'Test coverage',
    lens: 'Missing or weak tests for new behavior, untested edge cases, and regressions lacking coverage.',
  },
  {
    id: 'correctness',
    role: 'correctness',
    name: 'Correctness',
    lens: 'Logic errors, incorrect edge-case handling, race conditions, and broken invariants.',
  },
];

/** Council must have at least this many specialists selected when enabled. */
export const COUNCIL_MIN_SPECIALISTS = 2;
/** The persisted specialist array's upper bound (`CodeReviewCouncilConfigSchema`). */
export const COUNCIL_MAX_SPECIALISTS = 8;

// 'advisory'  — report votes/findings only; compute NO aggregate decision and NO merge gate.
// 'unanimous' — block unless EVERY specialist votes pass (i.e. any block → block). Strict.
// 'majority'  — block only when block votes outnumber pass votes. Lenient.
// ('any_blocking_member' from v1 is dropped: with no abstain it is identical to 'unanimous'.)
export const COUNCIL_AGGREGATION_STRATEGIES = ['advisory', 'unanimous', 'majority'] as const;
export type CouncilAggregationStrategy = (typeof COUNCIL_AGGREGATION_STRATEGIES)[number];

/** The safe default governance mode: report only, never gate a merge unasked. */
export const DEFAULT_COUNCIL_AGGREGATION_STRATEGY: CouncilAggregationStrategy = 'advisory';

/** Caps on the optional label gate; the config UI enforces the same bounds. */
export const COUNCIL_MAX_REQUIRED_LABELS = 20;
export const COUNCIL_REQUIRED_LABEL_MAX_LENGTH = 100;
