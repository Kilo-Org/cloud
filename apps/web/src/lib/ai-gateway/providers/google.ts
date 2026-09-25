export const GEMMA_4_26B_A4B_IT_ID = 'google/gemma-4-26b-a4b-it';
export const GEMMA_4_26B_A4B_IT_FREE_ID = 'google/gemma-4-26b-a4b-it:free';

export function isGeminiModel(model: string) {
  return model.includes('gemini');
}

export const GEMINI_PRO_CURRENT_MODEL_ID = 'google/gemini-3.1-pro-preview';

export const GEMINI_PRO_CURRENT_VERCEL_MODEL_ID = GEMINI_PRO_CURRENT_MODEL_ID;

export const GEMINI_FLASH_CURRENT_MODEL_ID = 'google/gemini-3.8-flash';

export const GEMINI_FLASH_CURRENT_VERCEL_MODEL_ID = GEMINI_FLASH_CURRENT_MODEL_ID;
