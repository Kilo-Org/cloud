/**
 * Get an environment variable value.
 * In Vercel deployments, these are injected by Vercel.
 * For local development, run `vercel env pull .env.development.local` to populate environment variables.
 */
export function getEnvVariable(key: string): string {
  return process.env[key] || '';
}

// Next.js inlines NEXT_PUBLIC_* at build time. Fail loudly when required
// environment variables are missing so misconfiguration surfaces at startup.
export function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
