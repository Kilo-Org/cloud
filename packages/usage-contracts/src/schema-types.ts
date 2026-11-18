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

// --- Organization ids ---

/**
 * The wire form of an `organizations.id` (packages/db, a Postgres `uuid` column). The check
 * matches the column's shape — any 8-4-4-4-12 hex GUID — so every stored id passes and a stored
 * organization keeps working across releases. Keep the check aligned with the column; a stricter
 * form requires checking stored ids first.
 */
export const KiloOrganizationIdSchema = z.guid();

export type KiloOrganizationId = z.infer<typeof KiloOrganizationIdSchema>;
