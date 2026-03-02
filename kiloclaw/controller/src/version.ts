/**
 * Controller version and commit, injected at build time via bun's --define flag.
 *
 * - KILOCLAW_CONTROLLER_VERSION: calver from $(date -u) at Docker build time (e.g. "2026.2.26")
 * - KILOCLAW_CONTROLLER_COMMIT: git SHA (passed as Docker build-arg from CI or push-dev.sh)
 *
 * Falls back to 'dev'/'unknown' when running unbundled (vitest, smoke tests).
 */

declare const KILOCLAW_CONTROLLER_VERSION: string | undefined;
declare const KILOCLAW_CONTROLLER_COMMIT: string | undefined;

// typeof checks avoid ReferenceError when identifiers aren't defined
// (vitest or running the source directly without bun build --define).
export const CONTROLLER_VERSION: string =
  typeof KILOCLAW_CONTROLLER_VERSION !== 'undefined' ? KILOCLAW_CONTROLLER_VERSION : 'dev';

export const CONTROLLER_COMMIT: string =
  typeof KILOCLAW_CONTROLLER_COMMIT !== 'undefined' ? KILOCLAW_CONTROLLER_COMMIT : 'unknown';
