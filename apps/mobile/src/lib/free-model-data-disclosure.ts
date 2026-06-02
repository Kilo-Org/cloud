export const FREE_MODEL_DATA_LABEL = 'Data collected';
export const FREE_MODEL_FREE_LABEL = 'Free';

export function isFreeModelOption(model: { id: string; isFree?: boolean } | undefined) {
  return model?.isFree === true;
}

export function getFreeModelDataAccessibilityLabel(label: string) {
  return `${label}, ${FREE_MODEL_DATA_LABEL}`;
}
