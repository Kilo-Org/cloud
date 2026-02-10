/**
 * Load environment variables for scripts running outside of Next.js.
 *
 * Next.js automatically loads .env files when running `next dev` or `next build`,
 * but standalone scripts (e.g., tsx, node) do not. This module ensures environment
 * variables are loaded before any code that depends on them executes.
 *
 * Follows Next.js convention: .env → .env.local (later files override earlier ones)
 * See: https://nextjs.org/docs/basic-features/environment-variables#environment-variable-load-order
 *
 * Import this at the top of any script that needs database access or other env vars:
 * ```ts
 * import './lib/load-env';
 * import { db } from './lib/drizzle';
 * ```
 */
import dotenv from 'dotenv';

// Load .env first (defaults)
dotenv.config({ path: '.env' });

// Load .env.local second (overrides)
dotenv.config({ path: '.env.local', override: true });
