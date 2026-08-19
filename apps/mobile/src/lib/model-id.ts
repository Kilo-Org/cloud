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

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

export function formatModelName(strippedId: string): string {
  return lookup(AUTO_MODEL_LABELS, strippedId) ?? strippedId;
}
