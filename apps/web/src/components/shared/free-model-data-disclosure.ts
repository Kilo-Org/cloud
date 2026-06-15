export const FREE_MODEL_DATA_LABEL = 'Data collected';
export const FREE_MODEL_FREE_LABEL = 'Free';

export function getFreeModelDataTooltip() {
  return FREE_MODEL_DATA_LABEL;
}

type ModelDataDisclosure = {
  id: string;
  isFree?: boolean;
  mayTrainOnYourPrompts?: boolean;
};

export function isFreeModelOption(model: ModelDataDisclosure | undefined) {
  return model?.isFree === true;
}

export function mayTrainOnYourPrompts(model: ModelDataDisclosure | undefined) {
  return model?.mayTrainOnYourPrompts === true;
}
