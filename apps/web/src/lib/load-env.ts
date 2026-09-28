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

// NODE_ENV belongs to the runtime, not to a dotenv file: `next dev` always runs
// with `development`, while a machine-local .env.local synced from a deployed
// environment can carry NODE_ENV="production". Letting the file override the
// process value stamped the tokens `pnpm dev:seed app:api-token` minted with
// `env: "production"` even though they are meant for this development runtime.
// Restore whatever the caller had after loading, exactly like Next.js, which
// sets NODE_ENV itself and never lets env files change it.
const nodeEnvBeforeLoad = process.env.NODE_ENV;

// Load .env first (defaults)
dotenv.config({ path: '.env' });

// Load .env.local second (overrides)
dotenv.config({ path: '.env.local', override: true });

// Next augments `ProcessEnv.NODE_ENV` as read-only, so the restore goes through
// Reflect rather than a direct delete/assign that the type checker rejects.
if (nodeEnvBeforeLoad === undefined) {
  Reflect.deleteProperty(process.env, 'NODE_ENV');
} else {
  Reflect.set(process.env, 'NODE_ENV', nodeEnvBeforeLoad);
}
