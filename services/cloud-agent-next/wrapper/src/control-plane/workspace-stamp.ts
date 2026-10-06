import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const STAMP_FILE = 'kilo-workspace.json';

const workspaceStampSchema = z
  .object({
    allocationId: z.string().min(1),
    commit: z.string(),
    /** Epoch ms of the capture this workspace descends from (or would be captured at). */
    capturedAt: z.number().int().nonnegative(),
    /** Refreshes since the last clone: 0 for a clone, one more per refresh of an adopted snapshot. */
    generation: z.number().int().nonnegative(),
  })
  .strict();

/** An adopted snapshot older than this is captured again, from the adopted workspace. */
export const SNAPSHOT_REFRESH_AFTER_MS = 4 * 24 * 60 * 60 * 1000;
/**
 * Refreshes allowed on top of a clone. Each capture stacks on the last, so deleted
 * files and untracked leftovers accumulate; once the cap is reached and the
 * snapshot is due again, it is rebuilt from a fresh clone instead.
 */
export const SNAPSHOT_MAX_GENERATION = 4;

/**
 * Written once a workspace is fully prepared: which allocation prepared it, at
 * which commit, and when and how many refreshes ago it was cloned and captured. A
 * stamp from another allocation means the files came from a repository snapshot,
 * so they are adopted (reconciled) before use.
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

/** What an adopted snapshot of this age and generation needs, if anything. */
export type SnapshotAction =
  /** Not due yet: adopt it as it is. */
  | 'keep'
  /** Due: adopt it, then capture the adopted workspace as the next generation. */
  | 'refresh'
  /** Due at the generation cap: discard it, clone fresh and capture as generation 0. */
  | 'rebuild';

export function snapshotAction(previous: WorkspaceStamp, now: number): SnapshotAction {
  if (now - previous.capturedAt < SNAPSHOT_REFRESH_AFTER_MS) return 'keep';
  return previous.generation < SNAPSHOT_MAX_GENERATION ? 'refresh' : 'rebuild';
}

export type StampPlan = {
  lineage: Pick<WorkspaceStamp, 'capturedAt' | 'generation'>;
  /** Whether this preparation should save the workspace as a repository snapshot. */
  capture: boolean;
};

/**
 * What a prepared workspace carries into its stamp and whether it is captured.
 * A fresh clone is captured as generation 0. An adopted snapshot is captured again
 * only when it is due for a refresh, and otherwise keeps its capture time and
 * generation, so its age keeps counting from the snapshot taken.
 */
export function planStamp(input: {
  cloning: boolean;
  adopted: boolean;
  previous: WorkspaceStamp | null;
  now: number;
}): StampPlan {
  const { cloning, adopted, previous, now } = input;
  if (adopted && previous !== null) {
    return snapshotAction(previous, now) === 'refresh'
      ? { lineage: { capturedAt: now, generation: previous.generation + 1 }, capture: true }
      : {
          lineage: { capturedAt: previous.capturedAt, generation: previous.generation },
          capture: false,
        };
  }
  return { lineage: { capturedAt: now, generation: 0 }, capture: cloning };
}
