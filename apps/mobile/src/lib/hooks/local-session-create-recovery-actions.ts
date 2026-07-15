import { type LocalSessionCreateRecovery } from './local-session-create-errors';

/**
 * Pure resolver that maps the orchestrator's typed `LocalSessionCreateRecovery`
 * branch onto exactly one rendering action (or terminal absence).
 *
 * The renderer owns the *visible* CTA surface; this module owns the *mapping*
 * from a recovery branch to the wire-level handler that the CTA must invoke.
 * The mapping is the only logic the screen must not re-implement, because the
 * recovery branch's `ctaLabel` is the single source of truth for whether a
 * CTA is shown.
 *
 * Branching:
 *
 * - `recovery === null`                  -> `{ kind: 'none' }`
 * - `ctaLabel === null` (non-retryable)  -> `{ kind: 'none' }`
 * - `ctaLabel === 'Retry'`               -> `{ kind: 'retry', ... }`
 * - `ctaLabel === 'Check again'`         -> `{ kind: 'check-again', ... }`
 * - `ctaLabel === 'Select runtime'`      -> `{ kind: 'select-runtime', ... }`
 * - `ctaLabel === 'Refresh catalog'`     -> `{ kind: 'refresh-catalog', ... }`
 *
 * The resolver always returns the same handler reference the caller passed
 * in; it never wraps, throttles, or replaces it. The screen passes
 * `isSubmitting` so the rendering layer can disable the button while a
 * request is in flight without this module needing to know about
 * React state.
 */
export type RecoveryCtaAction =
  | { kind: 'none' }
  | { kind: 'retry'; label: 'Retry'; onPress: () => void }
  | { kind: 'check-again'; label: 'Check again'; onPress: () => void }
  | { kind: 'select-runtime'; label: 'Select runtime'; onPress: () => void }
  | { kind: 'refresh-catalog'; label: 'Refresh catalog'; onPress: () => void };

export type ResolveRecoveryCtaActionInput = {
  recovery: LocalSessionCreateRecovery | null;
  isSubmitting: boolean;
  onRetry: () => void;
  onCheckAgain: () => void;
  onSelectRuntime: () => void;
  onRefreshCatalog: () => void;
};

export function resolveRecoveryCtaAction(input: ResolveRecoveryCtaActionInput): RecoveryCtaAction {
  const { recovery } = input;
  if (recovery === null) {
    return { kind: 'none' };
  }
  const ctaLabel = recovery.ctaLabel;
  if (ctaLabel === null) {
    return { kind: 'none' };
  }
  switch (ctaLabel) {
    case 'Retry': {
      return { kind: 'retry', label: 'Retry', onPress: input.onRetry };
    }
    case 'Check again': {
      return { kind: 'check-again', label: 'Check again', onPress: input.onCheckAgain };
    }
    case 'Select runtime': {
      return { kind: 'select-runtime', label: 'Select runtime', onPress: input.onSelectRuntime };
    }
    case 'Refresh catalog': {
      return { kind: 'refresh-catalog', label: 'Refresh catalog', onPress: input.onRefreshCatalog };
    }
    default: {
      // Exhaustive: `LocalSessionCreateRecovery.ctaLabel` is a string-literal
      // union; a future branch must be added here.
      const _exhaustive: never = ctaLabel;
      void _exhaustive;
      return { kind: 'none' };
    }
  }
}
