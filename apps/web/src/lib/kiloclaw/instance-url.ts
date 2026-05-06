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

/**
 * Process-local guard so the "misconfigured template" warning fires
 * once per worker/Node process instead of on every getStatus call.
 * Resets on cold start, which is the right granularity for operator
 * feedback after a config change.
 */
let warnedAboutMissingLabelPlaceholder = false;

export function workerUrlForInstance(params: {
  sandboxId: string | null;
  controllerCapabilitiesVersion: number | null;
  template: string;
  fallback: string;
}): string {
  const { sandboxId, controllerCapabilitiesVersion, template, fallback } = params;
  const legacyUrl = fallback || DEFAULT_LEGACY_URL;

  if (!template) return legacyUrl;
  if (!template.includes('{label}')) {
    // Operator set a template but forgot the placeholder. Silently
    // falling back to the legacy URL hides the misconfiguration; emit
    // a one-time warning so it shows up in logs.
    if (!warnedAboutMissingLabelPlaceholder) {
      warnedAboutMissingLabelPlaceholder = true;
      console.warn(
        '[workerUrlForInstance] KILOCLAW_INSTANCE_URL_TEMPLATE is set but missing the {label} placeholder; falling back to legacy URL'
      );
    }
    return legacyUrl;
  }
  if (!sandboxId) return legacyUrl;
  if ((controllerCapabilitiesVersion ?? 0) < MIN_CAPABILITY_VERSION_FOR_PER_INSTANCE_URL) {
    return legacyUrl;
  }
  const label = hostnameLabelFromSandboxId(sandboxId);
  if (!label) return legacyUrl;
  return template.replace('{label}', label);
}
