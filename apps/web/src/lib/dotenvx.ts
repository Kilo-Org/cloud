/**
 * Get an environment variable value.
 * In Vercel deployments, these are injected by Vercel.
 * For local development, run `vercel env pull .env.development.local` to populate environment variables.
 */
export function getEnvVariable(key: string): string {
  return process.env[key] || '';
}
