import { i18n } from '@/i18n';

/** An acronym the product keeps in English in every locale. */
export const BYOK_MODEL_LABEL = 'BYOK';

export function freeModelDataLabel(): string {
  return i18n.t('models.dataCollected');
}

export function freeModelFreeLabel(): string {
  return i18n.t('models.free');
}

export type ModelDataDisclosure = {
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
  return `${label}, ${freeModelDataLabel()}`;
}
