import { z } from 'zod';
import type { PromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

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

export function extractTranscriptionPromptInfo(): PromptInfo {
  return { system_prompt_length: 0, system_prompt_kind: null };
}
