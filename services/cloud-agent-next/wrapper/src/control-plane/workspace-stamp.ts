import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

const STAMP_FILE = 'kilo-workspace.json';

const workspaceStampSchema = z
  .object({
    allocationId: z.string().min(1),
    commit: z.string(),
    workspacePrepared: z.literal(false).optional(),
    // Lineage written by wrappers that captured session snapshots. Read only so
    // a stamp in an older snapshot still classifies; never written again.
    capturedAt: z.number().int().nonnegative().optional(),
    generation: z.number().int().nonnegative().optional(),
  })
  .strict();

export type WorkspaceStamp = z.infer<typeof workspaceStampSchema>;

/** What the filesystem says about a workspace, without asking the Worker. */
export type WorkspaceInspection =
  /** No repository: nothing to reuse. */
  | 'empty'
  /** A repository without a stamp: a preparation that did not finish. */
  | 'unstamped'
  /** Prepared by this allocation: a sibling session or a wrapper restart. */
  | 'same'
  /** Prepared by another allocation: a restored repository snapshot. */
  | 'foreign';

/**
 * Inside `.git` for a repository, so a clone never sees it as an untracked file;
 * beside the directory for a workspace that has no repository.
 */
export function workspaceStampPath(directory: string, hasGit: boolean): string {
  return hasGit
    ? path.join(directory, '.git', STAMP_FILE)
    : `${path.resolve(directory)}.${STAMP_FILE}`;
}

export async function readWorkspaceStamp(directory: string): Promise<WorkspaceStamp | null> {
  for (const hasGit of [true, false]) {
    try {
      const raw = await fs.readFile(workspaceStampPath(directory, hasGit), 'utf8');
      const parsed = workspaceStampSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        continue;
      return null;
    }
  }
  return null;
}

/** Replaces the stamp atomically so a snapshot never captures half a file. */
export async function writeWorkspaceStamp(
  directory: string,
  hasGit: boolean,
  stamp: WorkspaceStamp
): Promise<void> {
  const target = workspaceStampPath(directory, hasGit);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(stamp)}\n`);
  await fs.rename(temporary, target);
}

export function classifyWorkspace(input: {
  hasGit: boolean;
  stamp: WorkspaceStamp | null;
  allocationId: string;
}): WorkspaceInspection {
  const { hasGit, stamp, allocationId } = input;
  if (stamp?.workspacePrepared === false) return hasGit ? 'unstamped' : 'empty';
  if (stamp === null) return hasGit ? 'unstamped' : 'empty';
  if (stamp.allocationId === allocationId) return 'same';
  // A stamp beside a directory that has no repository has nothing to adopt.
  return hasGit ? 'foreign' : 'empty';
}

const SETUP_RECORD_FILE = 'kilo-environment-setup.json';

const environmentSetupRecordSchema = z
  .object({
    setupCommandCount: z.number().int().nonnegative(),
    setupCommandsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type EnvironmentSetupRecord = z.infer<typeof environmentSetupRecordSchema>;

export function environmentSetupRecord(commands: readonly string[]): EnvironmentSetupRecord {
  return {
    setupCommandCount: commands.length,
    setupCommandsSha256: createHash('sha256').update(JSON.stringify(commands)).digest('hex'),
  };
}

function setupRecordPath(directory: string): string {
  return path.join(directory, '.git', SETUP_RECORD_FILE);
}

/**
 * Written by an environment build into each repository's `.git`, beside its
 * stamp: the setup commands the snapshot already ran. A separate file, so a
 * wrapper that predates it still parses the strict stamp.
 */
export async function writeEnvironmentSetupRecord(
  directory: string,
  commands: readonly string[]
): Promise<void> {
  const target = setupRecordPath(directory);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(environmentSetupRecord(commands))}\n`);
  await fs.rename(temporary, target);
}

export async function readEnvironmentSetupRecord(
  directory: string
): Promise<EnvironmentSetupRecord | null> {
  try {
    const parsed = environmentSetupRecordSchema.safeParse(
      JSON.parse(await fs.readFile(setupRecordPath(directory), 'utf8'))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * How many leading setup commands a restored environment snapshot already ran:
 * every root must carry the same record, and the record must match the start of
 * this session's setup commands. Anything else is 0, so setup runs in full.
 */
export function setupCommandsCoveredBySnapshot(
  records: readonly (EnvironmentSetupRecord | null)[],
  commands: readonly string[]
): number {
  const [first] = records;
  if (first === undefined || first === null) return 0;
  if (records.some(record => record?.setupCommandsSha256 !== first.setupCommandsSha256)) return 0;
  if (first.setupCommandCount > commands.length) return 0;
  const expected = environmentSetupRecord(commands.slice(0, first.setupCommandCount));
  return expected.setupCommandsSha256 === first.setupCommandsSha256 ? first.setupCommandCount : 0;
}
