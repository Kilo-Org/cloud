/**
 * Feature flag for the `@kilocode/wl-sdk` routing seam (M1.8).
 *
 * Server-side only — read once per request from the worker `Env`.
 * Centralized here so the wanted-board dispatcher (and nothing else)
 * is the single place that branches on libwl vs SDK.
 *
 * Truthy values: `"1"`, `"true"`, `"yes"`, `"on"` (case-insensitive).
 * Anything else, including missing, falls back to the libwl path.
 *
 * The flag is configured per-deploy via `WL_SDK_ENABLED` in
 * `wrangler.jsonc`. Default OFF; M3 will remove the libwl path and
 * delete this helper.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function useWlSdk(env: Env): boolean {
  const raw = env.WL_SDK_ENABLED;
  if (typeof raw !== 'string') return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}
