import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const STAMP_FILE = 'kilo-workspace.json';

const workspaceStampSchema = z
  .object({
    allocationId: z.string().min(1),
    commit: z.string(),
    // Lineage written by wrappers that captured session snapshots. Read only so
    // a stamp in an older snapshot still classifies; never written again.
    capturedAt: z.number().int().nonnegative().optional(),
    generation: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Written once a workspace is fully prepared: which allocation prepared it and at
 * which commit. A stamp from another allocation means the files came from an
 * environment snapshot (the builder stamps with its own allocation), so they are
 * adopted (reconciled) before use.
 */
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

export async function readWorkspaceStamp(
  directory: string,
  hasGit: boolean
): Promise<WorkspaceStamp | null> {
  try {
    const raw = await fs.readFile(workspaceStampPath(directory, hasGit), 'utf8');
    const parsed = workspaceStampSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
  if (stamp === null) return hasGit ? 'unstamped' : 'empty';
  if (stamp.allocationId === allocationId) return 'same';
  // A stamp beside a directory that has no repository has nothing to adopt.
  return hasGit ? 'foreign' : 'empty';
}
