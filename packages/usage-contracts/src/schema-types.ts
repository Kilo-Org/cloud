import { z } from 'zod';

// --- AbuseClassification ---

export type AbuseClassification = (typeof ABUSE_CLASSIFICATION)[keyof typeof ABUSE_CLASSIFICATION];
export const ABUSE_CLASSIFICATION = {
  NOT_ABUSE: -100,
  CLASSIFICATION_ERROR: -50,
  NOT_CLASSIFIED: 0,
  LIKELY_ABUSE: 200,
} as const;

// --- Microdollar Usage --

export const GatewayApiKindSchema = z.enum([
  'chat_completions',
  'embeddings',
  'fim_completions',
  'edit_completions',
  'messages',
  'responses',
  'audio_transcriptions',
  'systemone',
]);

export type GatewayApiKind = z.infer<typeof GatewayApiKindSchema>;
