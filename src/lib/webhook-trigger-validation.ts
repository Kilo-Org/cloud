import * as z from 'zod';

/**
 * Reserved trigger IDs that cannot be used by users.
 * These are reserved for routing purposes in the UI.
 */
export const RESERVED_TRIGGER_IDS = [
  'new',
  'edit',
  'delete',
  'requests',
  'settings',
  'api',
  'admin',
] as const;

/**
 * Validation schema for trigger IDs (used by get/update/delete/list endpoints).
 * Accepts min(1) to remain compatible with any existing short IDs in production.
 *
 * Requirements:
 * - 1-64 characters
 * - Lowercase alphanumeric with hyphens only
 * - Cannot be a reserved word
 */
export const triggerIdSchema = z
  .string()
  .min(1, 'Trigger ID is required')
  .max(64, 'Trigger ID must be 64 characters or less')
  .regex(/^[a-z0-9-]+$/, 'Trigger ID must be lowercase alphanumeric with hyphens')
  .refine(
    id => !RESERVED_TRIGGER_IDS.includes(id as (typeof RESERVED_TRIGGER_IDS)[number]),
    'This trigger ID is reserved'
  );

/**
 * Stricter schema for new trigger creation.
 * Derives from triggerIdSchema to stay in sync, then adds a min-length guard
 * to prevent trivially guessable IDs in the webhook URL.
 */
export const triggerIdCreateSchema = triggerIdSchema.refine(
  id => id.length >= 8,
  'Trigger ID must be at least 8 characters'
);

/**
 * Transform user input to a valid trigger ID format.
 * - Converts to lowercase
 * - Replaces spaces with hyphens
 * - Removes invalid characters
 */
export function normalizeTriggerId(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}
