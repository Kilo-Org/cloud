import fs from 'node:fs/promises';
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
