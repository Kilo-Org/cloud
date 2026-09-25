export const QWEN37_MAX_MODEL_ID = 'qwen/qwen3.7-max';
export const QWEN37_PLUS_MODEL_ID = 'qwen/qwen3.7-plus';

export function isQwenModel(model: string) {
  return model.includes('qwen');
}

export function isQwenExplicitCacheModel(model: string) {
  return (
    (model.includes('qwen3.8') || model.includes('qwen3.7') || model.includes('qwen3.6')) &&
    (model.includes('max') || model.includes('plus'))
  );
}
