export const DEEPSEEK_V4_1_FLASH_ID = 'deepseek/deepseek-v4.1-flash';
export const DEEPSEEK_V4_1_FLASH_FREE_ID = 'deepseek/deepseek-v4.1-flash:free';

export function isDeepseekModel(model: string) {
  return model.includes('deepseek');
}
