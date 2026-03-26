import type { Phase } from '@/lib/custom-llm/schemas';
import type { FileAnnotation } from './provider-metadata';
import type { ReasoningDetailUnion } from './reasoning-details';

type OpenRouterCacheControl = { type: 'ephemeral' };

export type OpenRouterChatCompletionsInput = Array<ChatCompletionMessageParam>;

type ChatCompletionMessageParam =
  | ChatCompletionSystemMessageParam
  | ChatCompletionUserMessageParam
  | ChatCompletionAssistantMessageParam
  | ChatCompletionToolMessageParam;

interface ChatCompletionSystemMessageParam {
  role: 'system';
  content: string | Array<ChatCompletionContentPartText>;
}

interface ChatCompletionUserMessageParam {
  role: 'user';
  content: string | Array<ChatCompletionContentPart>;
  cache_control?: OpenRouterCacheControl;
}

export type ChatCompletionContentPart =
  | ChatCompletionContentPartText
  | ChatCompletionContentPartImage
  | ChatCompletionContentPartFile
  | ChatCompletionContentPartInputAudio;

interface ChatCompletionContentPartFile {
  type: 'file';
  file: {
    filename?: string;
    file_data?: string;
    file_id?: string;
  };
  cache_control?: OpenRouterCacheControl;
}

interface ChatCompletionContentPartImage {
  type: 'image_url';
  image_url: {
    url: string;
  };
  cache_control?: OpenRouterCacheControl;
}

interface ChatCompletionContentPartText {
  type: 'text';
  text: string;
  reasoning?: string | null;
  cache_control?: OpenRouterCacheControl;
}

type OpenRouterAudioFormat = 'wav' | 'mp3' | 'aiff' | 'aac' | 'ogg' | 'flac' | 'm4a' | 'pcm16' | 'pcm24';

interface ChatCompletionContentPartInputAudio {
  type: 'input_audio';
  input_audio: {
    data: string;
    format: OpenRouterAudioFormat;
  };
  cache_control?: OpenRouterCacheControl;
}

export interface ChatCompletionAssistantMessageParam {
  role: 'assistant';
  content?: string | null;
  reasoning?: string | null;
  reasoning_details?: ReasoningDetailUnion[];
  annotations?: FileAnnotation[];
  tool_calls?: Array<ChatCompletionMessageToolCall>;
  cache_control?: OpenRouterCacheControl;
  phase?: Phase | null;
}

interface ChatCompletionMessageToolCall {
  type: 'function';
  id: string;
  function: {
    arguments: string;
    name: string;
  };
}

interface ChatCompletionToolMessageParam {
  role: 'tool';
  content: string | Array<ChatCompletionContentPart>;
  tool_call_id: string;
  cache_control?: OpenRouterCacheControl;
}
