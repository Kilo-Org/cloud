export function isGemmaModel(model: string) {
  return model.includes('gemma');
}

export const GEMMA_4_26B_A4B_IT_ID = 'google/gemma-4-26b-a4b-it';

export function isGeminiModel(model: string) {
  return model.includes('gemini');
}

export function isGemini3Model(model: string) {
  return model.includes('gemini-3');
}

export const GEMINI_PRO_CURRENT_MODEL_ID = 'google/gemini-3.1-pro-preview';

export const GEMINI_PRO_CURRENT_VERCEL_MODEL_ID = GEMINI_PRO_CURRENT_MODEL_ID;

export const GEMINI_FLASH_CURRENT_MODEL_ID = 'google/gemini-3.6-flash';

export const GEMINI_FLASH_CURRENT_VERCEL_MODEL_ID = GEMINI_FLASH_CURRENT_MODEL_ID;
