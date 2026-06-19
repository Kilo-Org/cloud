export const BYOK_MODEL_LABEL = 'BYOK';
export const FREE_MODEL_DATA_LABEL = 'Data collected';
export const FREE_MODEL_FREE_LABEL = 'Free';

type ModelDataDisclosure = {
  id: string;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
  hasUserByokAvailable?: boolean;
};

export function isFreeModelOption(model: ModelDataDisclosure | undefined) {
  return model?.isFree === true;
}

export function mayTrainOnYourPrompts(model: ModelDataDisclosure | undefined) {
  return model?.mayTrainOnYourPrompts === true;
}

export function hasUserByokAvailable(model: ModelDataDisclosure | undefined) {
  return model?.hasUserByokAvailable === true;
}

export function getFreeModelDataAccessibilityLabel(label: string) {
  return `${label}, ${FREE_MODEL_DATA_LABEL}`;
}
