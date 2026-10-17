import { z } from 'zod';
import { RUNTIME_RESERVED_ROOT } from '../shared/runtime-distribution.js';

/**
 * Runtime launch phase receipt contract (amendment "cold session without a
 * snapshot").
 *
 * A launch parent mints one random `launchId`, passes it with an absolute
 * `deadlineAt` to `runtimeLaunchCommand()`, and later reads only its own
 * receipt. The embedded installer command writes exactly one bounded JSON
 * object under the reserved root with exclusive create:
 *
 *   { "launchId": "<id>", "outcome": "handoff" }
 *   { "launchId": "<id>", "outcome": "installer_failed", "code": <RUNTIME_INSTALLER_EXIT value> }
 *
 * A handoff receipt is written immediately before the final supervisor `exec`;
 * an installer failure receipt is written after cleanup and before exit. A
 * missing, stale, malformed, or id-mismatched file is not installer phase
 * proof, so a reader must not classify it as an artifact failure. This module is
 * pure: no filesystem and no Worker-only import, so the SDK reader and the
 * process harness share one contract.
 */

/** Directory under the reserved root that holds launch receipts. */
export const RUNTIME_LAUNCH_RECEIPT_DIR_NAME = 'launch-receipts';

/**
 * Hard byte bound for one receipt. The object is a few dozen bytes; the bound
 * rejects an oversized or appended file rather than parsing it.
 */
export const RUNTIME_LAUNCH_RECEIPT_MAX_BYTES = 512;

/**
 * Strict bounded nonce alphabet for a launch id. It has no path separator, no
 * dot, and no whitespace, so the id is safe as one file-name component. A
 * minted `crypto.randomUUID()` is a subset.
 */
export const RUNTIME_LAUNCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The one owner of the closed installer exit codes. The embedded installer, the
 * launch shell, the receipt schema and the failure-reason map all read this
 * table. The codes are disjoint from wrapper/supervisor exit codes;
 * `cliProbeFailed` and `supervisorMissing` are the shell/probe codes.
 */
export const RUNTIME_INSTALLER_EXIT = {
  artifactUnavailable: 70,
  artifactUnauthorized: 71,
  baseIncompatible: 72,
  artifactInvalid: 73,
  installInterrupted: 74,
  deadlineExceeded: 75,
  cliProbeFailed: 76,
  supervisorMissing: 77,
} as const;
export type RuntimeLaunchInstallerCode =
  (typeof RUNTIME_INSTALLER_EXIT)[keyof typeof RUNTIME_INSTALLER_EXIT];

const RUNTIME_LAUNCH_INSTALLER_CODES: ReadonlySet<number> = new Set(
  Object.values(RUNTIME_INSTALLER_EXIT)
);

function isRuntimeLaunchInstallerCode(value: unknown): value is RuntimeLaunchInstallerCode {
  return typeof value === 'number' && RUNTIME_LAUNCH_INSTALLER_CODES.has(value);
}

function isRuntimeLaunchId(value: string): boolean {
  return RUNTIME_LAUNCH_ID_PATTERN.test(value);
}

const launchIdSchema = z.string().regex(RUNTIME_LAUNCH_ID_PATTERN, 'invalid launch id');
const installerCodeSchema = z.custom<RuntimeLaunchInstallerCode>(isRuntimeLaunchInstallerCode);

export const runtimeLaunchReceiptSchema = z.union([
  z
    .object({
      launchId: launchIdSchema,
      outcome: z.literal('handoff'),
    })
    .strict(),
  z
    .object({
      launchId: launchIdSchema,
      outcome: z.literal('installer_failed'),
      code: installerCodeSchema,
    })
    .strict(),
]);
export type RuntimeLaunchReceipt = z.infer<typeof runtimeLaunchReceiptSchema>;

/**
 * The one owner of the receipt directory, shared by the writer, the observer,
 * and the acknowledgement that deletes a retained failure receipt. A fixture
 * passes its own reserved root; production uses the baked root.
 */
export function runtimeLaunchReceiptDir(reservedRoot: string = RUNTIME_RESERVED_ROOT): string {
  return `${reservedRoot}/${RUNTIME_LAUNCH_RECEIPT_DIR_NAME}`;
}

/**
 * The one owner of the receipt path. It rejects an unsafe id instead of
 * producing a path that could escape the reserved root. Deleting exactly this
 * path is the acknowledgement of a retained failure receipt.
 */
export function runtimeLaunchReceiptPath(
  launchId: string,
  reservedRoot: string = RUNTIME_RESERVED_ROOT
): string {
  if (!isRuntimeLaunchId(launchId)) {
    throw new Error('invalid runtime launch id');
  }
  return `${runtimeLaunchReceiptDir(reservedRoot)}/${launchId}.json`;
}
/**
 * Parse a receipt with the closed schema. Rejects an oversized payload before
 * JSON parsing. When `expectedLaunchId` is supplied, an id mismatch is rejected
 * as well, so a stale or foreign receipt can never be read as installer proof.
 */
export function parseRuntimeLaunchReceipt(
  input: string | Uint8Array,
  expectedLaunchId?: string
): RuntimeLaunchReceipt {
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
  if (new TextEncoder().encode(text).byteLength > RUNTIME_LAUNCH_RECEIPT_MAX_BYTES) {
    throw new Error('runtime launch receipt exceeds the byte bound');
  }
  const receipt = runtimeLaunchReceiptSchema.parse(JSON.parse(text));
  if (expectedLaunchId !== undefined && receipt.launchId !== expectedLaunchId) {
    throw new Error('runtime launch receipt id mismatch');
  }
  return receipt;
}
