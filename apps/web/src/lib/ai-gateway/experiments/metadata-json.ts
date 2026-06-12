import { CustomLlmMetadataSchema, type CustomLlmMetadata } from '@kilocode/db/schema-types';
import { deepStrict } from '@/lib/zod/deep-strict';
import * as z from 'zod';

const StrictCustomLlmMetadataSchema = deepStrict(CustomLlmMetadataSchema);

type MetadataParseResult =
  | { success: true; data: CustomLlmMetadata | null }
  | { success: false; error: string };

export function parseMetadataJson(value: string): MetadataParseResult {
  if (!value.trim()) {
    return { success: true, data: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { success: false, error: 'Invalid JSON syntax' };
  }

  if (parsed === null) {
    return { success: true, data: null };
  }

  const result = StrictCustomLlmMetadataSchema.safeParse(parsed);
  if (!result.success) {
    return { success: false, error: z.prettifyError(result.error) };
  }

  return { success: true, data: result.data };
}
