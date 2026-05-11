import { z } from 'zod';

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
    provider: z.record(z.string(), z.unknown()).optional(),
    safety_identifier: z.string().optional(),
    user: z.string().optional(),
  })
  .passthrough();

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

const TRANSCRIPTION_PROVIDER_SLUGS: Record<string, readonly string[]> = {
  'google/chirp-3': ['google-vertex'],
  'openai/gpt-4o-mini-transcribe': ['openai'],
  'openai/gpt-4o-transcribe': ['openai'],
  'openai/whisper-1': ['openai'],
  'openai/whisper-large-v3': ['groq'],
  'openai/whisper-large-v3-turbo': ['groq'],
};

export function isTranscriptionProviderAllowed(
  model: string,
  allow: readonly string[] | undefined
) {
  if (!allow) return true;
  const slugs = TRANSCRIPTION_PROVIDER_SLUGS[model];
  if (!slugs) return false;
  return slugs.some(slug => allow.includes(slug));
}
