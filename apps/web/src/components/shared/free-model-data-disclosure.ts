export const FREE_MODEL_DATA_LABEL = 'Data collected';
export const FREE_MODEL_FREE_LABEL = 'Free';

export function getFreeModelDataTooltip() {
  return FREE_MODEL_DATA_LABEL;
}

export function isFreeModelOption(model: { id: string; isFree?: boolean } | undefined) {
  return model?.isFree === true;
}
