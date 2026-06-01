export const FREE_MODEL_DATA_LABEL = 'Data collected';

export function isFreeModelOption(model: { id: string; isFree?: boolean } | undefined) {
  if (!model) {
    return false;
  }
  return (
    model.isFree === true ||
    model.id === 'kilo-auto/free' ||
    model.id.endsWith(':free') ||
    model.id === 'openrouter/free'
  );
}

export function getFreeModelDataAccessibilityLabel(label: string) {
  return `${label}, ${FREE_MODEL_DATA_LABEL}`;
}
