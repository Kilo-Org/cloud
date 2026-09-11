/**
 * Barrel module for the mobile first-run tour package.
 *
 * Leaf modules live in `./tour-state.ts` and `./tour-facts.ts`. This file
 * must not add any local definitions — doing so risks re-introducing an
 * import cycle with the leaf modules.
 */

export {
  firstRunTourStorageKey,
  isFirstRunTourStatus,
  loadFirstRunTourDecision,
  markFirstRunTourStatus,
  parseFirstRunTourRecord,
  type FirstRunTourStatus,
} from './tour-state';

// `FirstRunTourDecision` and `TourFactsInput` are re-exported by their leaf
// modules only: their consumers (the gate and the facts tests) import the
// leaves directly, and an unused barrel re-export fails `pnpm check:unused`.
export { classifyTourFacts, type TourFacts } from './tour-facts';
