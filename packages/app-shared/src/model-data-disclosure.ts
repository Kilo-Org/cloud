/**
 * Model data-disclosure facts shared by the web and mobile model pickers.
 *
 * One model row exposes three disclosure facts: whether the model is free,
 * whether prompts may be used to train it, and whether the user can serve it
 * through their own BYOK provider. The predicates are pure so the same rule
 * renders the same badge on every platform.
 */

/** Acronym the product keeps in English in every locale. */
export const BYOK_MODEL_LABEL = 'BYOK';

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
