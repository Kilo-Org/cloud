/**
 * Shared model utilities that can be used on both client and server.
 * Keep this file free of server-only dependencies.
 */

/**
 * Public-id namespace prefixes for Kilo-owned models. These are reserved and
 * must not be claimed by partner experiment public ids or custom upstreams.
 *
 * The names look swapped but are intentional: Kilo Code (the extension) selects
 * Kilo-hosted models under `kilo/`, while KiloClaw selects them under
 * `kilocode/`. `kilo-internal/` is the custom LLM (`custom_llm2`) namespace.
 */
export const KILOCODE_KILO_PROVIDER_PREFIX = 'kilo/';
export const KILOCLAW_KILO_PROVIDER_PREFIX = 'kilocode/';
export const CUSTOM_LLM_PREFIX = 'kilo-internal/';

/**
 * Normalize a model ID by removing the `:free`, `:exacto`, etc. suffixes if present.
 */
export function normalizeModelId(modelId: string): string {
  const colonIndex = modelId.indexOf(':');
  return colonIndex >= 0 ? modelId.substring(0, colonIndex) : modelId;
}
