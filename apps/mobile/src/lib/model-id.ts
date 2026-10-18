export function stripModelPrefix(modelId: string | null | undefined): string {
  if (!modelId) {
    return '';
  }
  return modelId.replace(/^kilocode\//, '');
}
