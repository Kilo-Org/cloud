export function isGlmModel(model: string) {
  return model.includes('glm');
}

// Partner routing stays pinned when the current GLM model changes.
export const FRIENDLI_GLM_PUBLIC_ID = 'z-ai/glm-5.2';
export const GLM_CURRENT_MODEL_ID = 'z-ai/glm-5.2';
