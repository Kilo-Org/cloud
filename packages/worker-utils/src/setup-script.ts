import { z } from 'zod';

/**
 * Shared by environment storage, session admission, persistence, the setup agent, and
 * wrapper frames. Longer setup belongs in a repository script that the setup script calls.
 * 16,000 characters is at most 48 KB of UTF-8, under the Linux limit for the one exec
 * argument that carries the script.
 */
export const SETUP_SCRIPT_LIMITS = {
  MAX_SCRIPTS: 20,
  MAX_LENGTH: 16_000,
} as const;

export const setupScriptSchema = z.string().max(SETUP_SCRIPT_LIMITS.MAX_LENGTH);

export const setupCommandsSchema = z.array(setupScriptSchema).max(SETUP_SCRIPT_LIMITS.MAX_SCRIPTS);
