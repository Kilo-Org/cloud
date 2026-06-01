export const FREE_MODEL_DATA_LABEL = 'Data collected';
export const FREE_MODEL_FREE_LABEL = 'Free';

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

export function isFreeKiloGatewayModelOption(model: { id: string; isFree?: boolean } | undefined) {
  if (!model) {
    return false;
  }
  return (
    model.id === 'kilo-auto/free' || (model.isFree === true && model.id.startsWith('kilo-auto/'))
  );
}
