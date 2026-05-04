/**
 * Per-instance worker URL minting.
 *
 * Returns the dashboard-facing URL the browser should use to talk to a
 * specific KiloClaw instance.
 *
 * When `KILOCLAW_INSTANCE_URL_TEMPLATE` is set (e.g.
 * `https://{label}.kiloclaw.ai`) AND the instance is on the post-PR1
 * controller contract (`controllerCapabilitiesVersion >= 2`), the
 * template is expanded with the sandboxId's hostname label. Otherwise
 * falls back to the legacy single-host `KILOCLAW_API_URL`.
 *
 * The capability gate matters: v1 machines don't have the per-instance
 * origin in their OpenClaw allowlist, so WebSocket upgrades from the
 * per-instance host would fail openclaw's exact-match origin check.
 * Keeping v1 instances on the legacy host until they restart onto v2
 * avoids a user-visible regression.
 *
 * Inputs:
 *   - `sandboxId`: DO's authoritative sandboxId (null for no-instance sentinel)
 *   - `controllerCapabilitiesVersion`: from the worker's `getStatus`
 *     (null → treat as pre-v1, legacy host)
 *   - `template`: `KILOCLAW_INSTANCE_URL_TEMPLATE` (empty → legacy host)
 *   - `fallback`: `KILOCLAW_API_URL` (empty → "https://claw.kilo.ai")
 */

import { hostnameLabelFromSandboxId } from '@kilocode/worker-utils/hostname-label';

const MIN_CAPABILITY_VERSION_FOR_PER_INSTANCE_URL = 2;

const DEFAULT_LEGACY_URL = 'https://claw.kilo.ai';

export function workerUrlForInstance(params: {
  sandboxId: string | null;
  controllerCapabilitiesVersion: number | null;
  template: string;
  fallback: string;
}): string {
  const { sandboxId, controllerCapabilitiesVersion, template, fallback } = params;
  const legacyUrl = fallback || DEFAULT_LEGACY_URL;

  if (!template || !template.includes('{label}')) return legacyUrl;
  if (!sandboxId) return legacyUrl;
  if ((controllerCapabilitiesVersion ?? 0) < MIN_CAPABILITY_VERSION_FOR_PER_INSTANCE_URL) {
    return legacyUrl;
  }
  const label = hostnameLabelFromSandboxId(sandboxId);
  if (!label) return legacyUrl;
  return template.replace('{label}', label);
}
