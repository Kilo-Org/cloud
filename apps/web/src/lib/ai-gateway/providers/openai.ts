import { modelStartsWith } from '@/lib/ai-gateway/providers/model-prefix';

export function isOpenAiModel(requestedModel: string) {
  return (
    modelStartsWith(requestedModel, 'openai/') && !modelStartsWith(requestedModel, 'openai/gpt-oss')
  );
}

export function isOpenAiOssModel(requestedModel: string) {
  return modelStartsWith(requestedModel, 'openai/gpt-oss');
}
