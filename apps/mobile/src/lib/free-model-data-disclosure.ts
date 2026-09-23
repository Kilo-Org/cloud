import { i18n } from '@/i18n';

import { stripModelPrefix } from './model-id';

/** An acronym the product keeps in English in every locale. */
export const BYOK_MODEL_LABEL = 'BYOK';

export function freeModelDataLabel(): string {
  return i18n.t('models.dataCollected');
}

export function freeModelFreeLabel(): string {
  return i18n.t('models.free');
}

/** The gateway catalogue's own marker for a free model: `Laguna S 2.1 (free)`. */
const CATALOG_FREE_MARKER = /\(free\)/i;

/** Kilo's own Auto Free model: its localized name is a free name in every catalog. */
const FREE_AUTO_MODEL_ID = 'kilo-auto/free';

/**
 * Whether the displayed model name already states that the model is free.
 * The gateway catalogue names free models "… (free)", and Kilo's own Auto Free
 * model is named for it in every catalog, so a free badge beside such a name
 * would print the same fact twice on one row.
 *
 * Nine catalogs name Auto Free with a free word the badge's own label does not
 * literally contain (ru "Авто Бесплатный" vs "Бесплатно"), so the model's
 * identity decides as well: `displayId` is the model the picker resolved the
 * label from, and the free Auto model always states free.
 */
export function modelNameStatesFree(name: string, displayId?: string): boolean {
  if (displayId && stripModelPrefix(displayId) === FREE_AUTO_MODEL_ID) {
    return true;
  }
  const freeLabel = freeModelFreeLabel();
  const locale = i18n.language;
  return (
    CATALOG_FREE_MARKER.test(name) ||
    (freeLabel.length > 0 &&
      name.toLocaleLowerCase(locale).includes(freeLabel.toLocaleLowerCase(locale)))
  );
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
