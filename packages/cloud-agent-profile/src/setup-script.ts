import { z } from 'zod';

/** Shared by environment storage, session admission, persistence, and wrapper frames. */
export const SETUP_SCRIPT_LIMITS = {
  MAX_SCRIPTS: 20,
  MAX_LENGTH: 16_000,
} as const;

export const setupCommandsSchema = z
  .array(z.string().max(SETUP_SCRIPT_LIMITS.MAX_LENGTH))
  .max(SETUP_SCRIPT_LIMITS.MAX_SCRIPTS);
