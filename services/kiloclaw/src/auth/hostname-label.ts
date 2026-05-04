/**
 * Hostname label helpers.
 *
 * Canonical implementation lives in `@kilocode/worker-utils/hostname-label`
 * so it can be shared with `apps/web` (per-instance URL minting) without
 * duplicating the label encoding. This module is a thin re-export shim
 * kept in place so the many existing `./auth/hostname-label` imports in
 * the worker don't have to migrate all at once.
 */

export {
  MAX_HOSTNAME_LABEL_LENGTH,
  hostnameLabelFromSandboxId,
  sandboxIdFromHostnameLabel,
  instanceUrl,
  hostMatchesInstanceSuffix,
  parseInstanceHost,
} from '@kilocode/worker-utils/hostname-label';
export type { HostSuffixEnv } from '@kilocode/worker-utils/hostname-label';
