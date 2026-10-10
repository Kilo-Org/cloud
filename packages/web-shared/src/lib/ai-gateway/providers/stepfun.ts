export const STEP_5_PREVIEW_FREE_MODEL_ID = 'stepfun/step-5-preview-free';

export function isStepModel(requestedModel: string) {
  return requestedModel.includes('step-');
}
