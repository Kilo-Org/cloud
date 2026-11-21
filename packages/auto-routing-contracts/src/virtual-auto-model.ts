/**
 * The namespace reserved for models the platform routes itself. A model named in this namespace
 * is not a concrete model, so it can never be a routing pool entry, a `measuredAs` target, or a
 * denied candidate.
 *
 * Leaf module: it imports nothing, so `custom-router.ts` and the package root can share the rule
 * without a package-root cycle.
 */
export const KILO_AUTO_MODEL_NAMESPACE_PREFIX = 'kilo-auto/';

/** True when `model` names the reserved auto-model namespace, for any spelling of the prefix. */
export function isVirtualAutoModelId(model: string): boolean {
  return model.trim().toLowerCase().startsWith(KILO_AUTO_MODEL_NAMESPACE_PREFIX);
}
