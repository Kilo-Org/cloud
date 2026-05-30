export const FREE_MODEL_DATA_LABEL = 'Free - data collected';
export const FREE_MODEL_DATA_SHORT_LABEL = 'Data collected';

export function isFreeModelOption(model: { id: string; isFree?: boolean } | undefined) {
  if (!model) {
    return false;
  }
  return (
    model.isFree === true ||
    model.id === 'kilo-auto/free' ||
    model.id.endsWith(':free') ||
    model.id === 'openrouter/free' ||
    (model.id.startsWith('openrouter/') &&
      (model.id.endsWith('-alpha') || model.id.endsWith('-beta')))
  );
}

export function getFreeModelDataAccessibilityLabel(label: string) {
  return `${label}, free model, usage data collected`;
}
