export { isQwenModel } from '@kilocode/worker-utils/model-families';

export function isQwenExplicitCacheModel(model: string) {
  return (
    (model.includes('qwen3.8') || model.includes('qwen3.7') || model.includes('qwen3.6')) &&
    (model.includes('max') || model.includes('plus'))
  );
}
