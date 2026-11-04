import { z } from 'zod';
import {
  gatewayModelSchema,
  gatewayProviderSchema,
} from '@kilocode/web-shared/lib/ai-gateway/request-validation';

export const TranscriptionInputAudioSchema = z.object({
  data: z.string().min(1),
  format: z.string().min(1),
});

export const TranscriptionRequestSchema = z.looseObject({
  model: gatewayModelSchema,
  input_audio: TranscriptionInputAudioSchema,
  language: z.string().min(1).nullish(),
  temperature: z.number().nullish(),
  provider: gatewayProviderSchema.nullish(),
  safety_identifier: z.string().nullish(),
  user: z.string().nullish(),
});

export type TranscriptionRequest = z.infer<typeof TranscriptionRequestSchema>;

export function buildUpstreamBody(body: TranscriptionRequest): Record<string, unknown> {
  return body;
}

export function extractTranscriptionPromptInfo(body: TranscriptionRequest) {
  const format = body.input_audio.format.slice(0, 100);
  const language = body.language ? ` language=${body.language.slice(0, 32)}` : '';
  return {
    system_prompt_prefix: '',
    system_prompt_length: 0,
    user_prompt_prefix: `audio/${format}${language}`.slice(0, 100),
  };
}
