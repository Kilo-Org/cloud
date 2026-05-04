/**
 * SandboxId encoding helpers.
 *
 * Canonical implementation lives in `@kilocode/worker-utils/sandbox-id`
 * so it can be shared with `apps/web` (per-instance URL minting) without
 * duplicating the base64url encoding. This module is a thin re-export
 * shim kept in place so the many existing `./auth/sandbox-id` imports in
 * the worker don't have to migrate all at once.
 */

export {
  sandboxIdFromUserId,
  userIdFromSandboxId,
  isValidInstanceId,
  sandboxIdFromInstanceId,
} from '@kilocode/worker-utils/sandbox-id';
