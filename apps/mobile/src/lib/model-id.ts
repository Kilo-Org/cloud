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
