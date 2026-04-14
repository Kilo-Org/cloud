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

const AUTO_MODEL_LABELS: Record<string, string> = {
  'kilo-auto/frontier': 'Frontier',
  'kilo-auto/balanced': 'Balanced',
};

export function formatModelName(strippedId: string): string {
  return AUTO_MODEL_LABELS[strippedId] ?? strippedId;
}
