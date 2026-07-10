import { z } from 'zod';
import { convertProviderOptions } from '@/lib/ai-gateway/providers/vercel';

export const TranscriptionInputAudioSchema = z.object({
  data: z.string().min(1),
  format: z.string().min(1),
});

export const TranscriptionRequestSchema = z
  .object({
    model: z.string().min(1),
    input_audio: TranscriptionInputAudioSchema,
    language: z.string().min(1).optional(),
    temperature: z.number().optional(),
    provider: z
      .object({
        order: z.array(z.string()).optional(),
        only: z.array(z.string()).optional(),
        ignore: z.array(z.string()).optional(),
        data_collection: z.enum(['allow', 'deny']).optional(),
        zdr: z.boolean().optional(),
        require_parameters: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    safety_identifier: z.string().optional(),
    user: z.string().optional(),
  })
  .passthrough();

export type TranscriptionRequest = z.infer<typeof TranscriptionRequestSchema>;

export function buildUpstreamBody(body: TranscriptionRequest): Record<string, unknown> {
  return body;
}

const AUDIO_MEDIA_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

export function buildVercelTranscriptionBody(body: TranscriptionRequest): Record<string, unknown> {
  const mediaType = body.input_audio.format.includes('/')
    ? body.input_audio.format
    : (AUDIO_MEDIA_TYPES[body.input_audio.format.toLowerCase()] ??
      `audio/${body.input_audio.format.toLowerCase()}`);
  const providerOptions = {
    ...convertProviderOptions(body.provider),
    ...(body.language !== undefined || body.temperature !== undefined
      ? { openai: { language: body.language, temperature: body.temperature } }
      : {}),
  };

  return {
    audio: body.input_audio.data,
    mediaType,
    ...(providerOptions.gateway && { providerOptions }),
  };
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
