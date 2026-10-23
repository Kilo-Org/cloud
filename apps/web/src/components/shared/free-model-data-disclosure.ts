export {
  BYOK_MODEL_LABEL,
  hasUserByokAvailable,
  isFreeModelOption,
  mayTrainOnYourPrompts,
} from '@kilocode/app-shared/model-data-disclosure';

export const FREE_MODEL_DATA_LABEL = 'Data collected';
export const FREE_MODEL_FREE_LABEL = 'Free';

export function getFreeModelDataTooltip() {
  return FREE_MODEL_DATA_LABEL;
}
