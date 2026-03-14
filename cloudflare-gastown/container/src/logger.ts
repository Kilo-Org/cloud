/**
 * Structured logger for the container process.
 *
 * Outputs JSON to console.* so entries appear in Workers Logs
 * (captured via `observability: { enabled: true }` in wrangler.jsonc).
 * Keep this module dependency-free and synchronous.
 */

function flatten(data?: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  return data as Record<string, unknown>;
}

export const log = {
  info: (msg: string, data?: unknown) =>
    console.log(
      JSON.stringify({ level: 'info', msg, ...flatten(data), ts: new Date().toISOString() })
    ),
  warn: (msg: string, data?: unknown) =>
    console.warn(
      JSON.stringify({ level: 'warn', msg, ...flatten(data), ts: new Date().toISOString() })
    ),
  error: (msg: string, data?: unknown) =>
    console.error(
      JSON.stringify({ level: 'error', msg, ...flatten(data), ts: new Date().toISOString() })
    ),
};
