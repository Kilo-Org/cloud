import { z } from 'zod';
import { sha256Hex } from '../utils/sha256.js';

export const WARM_BASE_TTL_MS = 24 * 60 * 60 * 1000;

const WARM_WORKSPACE_ROOT = '/workspace/warm';
const WARM_HOME_ROOT = '/tmp/kilo-worktrees/warm';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type WarmBaseDigestInput = {
  owner: string;
  repositoryUrl: string;
  setupCommands: readonly string[];
  preparationEnvIdentity: string;
  wrapperVersion: string;
  image: string;
  instance: string;
};

export function warmBaseDigest(input: WarmBaseDigestInput): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      input.owner,
      input.repositoryUrl,
      [...input.setupCommands],
      input.preparationEnvIdentity,
      input.wrapperVersion,
      input.image,
      input.instance,
    ])
  );
}

/**
 * The only signal that an attach must re-prepare a warm-restored workspace.
 * `needsPreparation` is the caller's post-launch wrapper comparison; `pending`
 * is the container record's unacknowledged-restore bit re-read after launch.
 */
export function attachRestoredFromBackup(needsPreparation: boolean, pending: boolean): boolean {
  return needsPreparation && pending;
}

export function warmBasePreparationEnvIdentity(
  envVars: Record<string, string> | undefined,
  hasEncryptedSecrets: boolean
): string | undefined {
  if (hasEncryptedSecrets) return undefined;
  const entries = Object.entries(envVars ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return JSON.stringify(entries);
}

export const warmBaseRecordSchema = z
  .object({ id: z.string().min(1), expiresAt: z.number() })
  .strict();

export type WarmBaseRecord = z.infer<typeof warmBaseRecordSchema>;

export function readWarmBaseRecord(value: unknown): WarmBaseRecord | null {
  const parsed = warmBaseRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function activeWarmBaseId(record: WarmBaseRecord | null, now: number): string | undefined {
  if (record === null || record.expiresAt <= now) return undefined;
  return record.id;
}

export function warmBasePaths(digest: string): { workspace: string; home: string } {
  return { workspace: `${WARM_WORKSPACE_ROOT}/${digest}`, home: `${WARM_HOME_ROOT}/${digest}` };
}

export function warmBaseHomeForWorkspace(workspacePath: string | undefined): string | undefined {
  if (workspacePath === undefined) return undefined;
  const prefix = `${WARM_WORKSPACE_ROOT}/`;
  if (!workspacePath.startsWith(prefix)) return undefined;
  const digest = workspacePath.slice(prefix.length);
  return DIGEST_PATTERN.test(digest) ? warmBasePaths(digest).home : undefined;
}

export type WarmBaseWorkspaceDecision = {
  eligible: boolean;
  continuation: boolean;
  directory: string;
};

export function selectWarmBaseWorkspace(input: {
  currentPath: string | undefined;
  sessionSlot: string | null;
  hasPreparationHistory: boolean;
  legacyDirectory: string;
  expectedWorkspace: string;
}): WarmBaseWorkspaceDecision {
  if (input.currentPath !== undefined) {
    if (input.currentPath !== input.expectedWorkspace) {
      return { eligible: false, continuation: false, directory: input.currentPath };
    }
    if (input.sessionSlot !== null) {
      return { eligible: false, continuation: false, directory: input.currentPath };
    }
    return { eligible: true, continuation: true, directory: input.currentPath };
  }
  if (input.hasPreparationHistory || input.sessionSlot !== null) {
    return { eligible: false, continuation: false, directory: input.legacyDirectory };
  }
  return { eligible: true, continuation: false, directory: input.expectedWorkspace };
}

export function selectStartSnapshot(
  sessionSlot: string | null | undefined,
  warmId: string | null | undefined
): string | undefined {
  return sessionSlot ?? warmId ?? undefined;
}
