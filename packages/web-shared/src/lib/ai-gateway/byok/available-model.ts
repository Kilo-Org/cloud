/** A model decorated as served by the caller's own credential: BYOK-available and never free. */
export type ByokAvailableModel<T> = T & { hasUserByokAvailable: true; isFree: false };

/**
 * One construction of the BYOK-available annotation, so a new tagging site cannot set
 * `hasUserByokAvailable` without also clearing `isFree`. A model that stays untagged is
 * returned as it is, so callers apply this only where they mark one.
 */
export function markByokAvailable<T extends object>(model: T): ByokAvailableModel<T> {
  return { ...model, hasUserByokAvailable: true, isFree: false };
}
