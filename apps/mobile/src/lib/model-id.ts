const MODEL_PREFIX = 'kilocode/';

export function stripModelPrefix(modelId: string | null | undefined): string {
  if (!modelId) {
    return '';
  }
  return modelId.replace(/^kilocode\//, '');
}

export function addModelPrefix(modelId: string): string {
  return `${MODEL_PREFIX}${modelId}`;
}

const AUTO_MODEL_LABELS = {
  'kilo-auto/frontier': 'Frontier',
  'kilo-auto/balanced': 'Balanced',
} satisfies Record<string, string>;

/**
 * i18n keys for Kilo's own auto-model names.
 *
 * The gateway names every auto model `Auto <Tier>`, so the app would otherwise
 * render an English product name in the middle of a translated screen (the
 * composer's model chip was the one English word left in the Arabic new-session
 * screen). Kilo owns these names, so they go through the catalogs like every
 * other piece of the app's copy; third-party model names stay as the gateway
 * spells them.
 */
const AUTO_MODEL_NAME_KEYS = {
  'kilo-auto/balanced': 'common.autoModelBalanced',
  'kilo-auto/efficient': 'common.autoModelEfficient',
  'kilo-auto/free': 'common.autoModelFree',
  'kilo-auto/frontier': 'common.autoModelFrontier',
  'kilo-auto/small': 'common.autoModelSmall',
} satisfies Record<string, string>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

/**
 * The i18n key for a Kilo auto model's display name, or `undefined` for any
 * other model. Callers fall back to the catalog name when this returns nothing.
 */
export function autoModelNameKey(modelId: string | null | undefined): string | undefined {
  return modelId ? lookup(AUTO_MODEL_NAME_KEYS, modelId) : undefined;
}

export function formatModelName(strippedId: string): string {
  return lookup(AUTO_MODEL_LABELS, strippedId) ?? strippedId;
}
