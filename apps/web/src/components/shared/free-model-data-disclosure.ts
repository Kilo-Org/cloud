export const FREE_MODEL_DATA_LABEL = 'Data collected';

export function getFreeModelDataTooltip() {
  return FREE_MODEL_DATA_LABEL;
}

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
