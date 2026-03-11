/**
 * KiloClawInstance Durable Object — stable public entrypoint.
 *
 * The implementation lives in ./kiloclaw-instance/ (directory module).
 * This file re-exports everything so existing import paths remain valid.
 */
export {
  KiloClawInstance,
  parseRegions,
  shuffleRegions,
  deprioritizeRegion,
  selectRecoveryCandidate,
  METADATA_KEY_USER_ID,
} from './kiloclaw-instance/index';
