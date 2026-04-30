import { modelStartsWith } from '@/lib/ai-gateway/providers/model-prefix';

export function isDeepseekModel(model: string) {
  return modelStartsWith(model, 'deepseek/');
}
