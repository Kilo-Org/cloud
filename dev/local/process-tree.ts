import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Process-tree inspection for tmux panes.
 *
 * A pane shell always has children of its own kind: the service wrapper is
 * `$SHELL -lc '<cmd>; exec $SHELL -l'`, ctrl-c and dashboard clicks can leave
 * an extra login shell parented to the pane, and pnpm runs package scripts
 * through an intermediate `sh -c`. "Has any child" therefore cannot tell a
 * dying service from an idle pane — the question is whether the tree below the
 * pane contains a process that is *not* a shell.
 */

type ProcessRow = {
  pid: number;
  ppid: number;
  command: string;
};

// Interactive shells only. A pane whose tree is all shells is idle: anything a
// user or the CLI typed has already exited.
const SHELL_COMMANDS = new Set([
  'ash',
  'bash',
  'csh',
  'dash',
  'fish',
  'ksh',
  'login',
  'nu',
  'sh',
  'tcsh',
  'zsh',
]);

/** `ps` prints login shells as `-zsh`, and paths for non-PATH binaries. */
function normalizeCommand(command: string): string {
  return path.basename(command.trim()).replace(/^-/, '');
}

function isShellCommand(command: string): boolean {
  return SHELL_COMMANDS.has(normalizeCommand(command));
}

/** Parse `ps -Ao pid=,ppid=,comm=` output. Malformed lines are skipped. */
function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    });
  }
  return rows;
}

/**
 * One snapshot of the whole table, not one `ps` per pid: restart polls this
 * every 500ms against a tree that is actively dying, and per-pid calls would
 * read a half-consistent tree.
 */
function snapshotProcessTable(): ProcessRow[] {
  try {
    return parseProcessTable(
      execFileSync('ps', ['-Ao', 'pid=,ppid=,comm='], {
        encoding: 'utf-8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 2000, // restart polls this every 500ms; never let it wedge
      })
    );
  } catch {
    return [];
  }
}

function childrenByParent(rows: ProcessRow[]): Map<number, ProcessRow[]> {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }
  return byParent;
}

/**
 * Whether any descendant of `rootPid` is a non-shell process. Walks the full
 * tree: a live `pnpm run dev` sits under one or more shell layers, so stopping
 * at the first shell child would call a running service idle.
 *
 * `rootPid` itself is excluded — it is the pane's own shell.
 */
function hasNonShellDescendant(rows: ProcessRow[], rootPid: number): boolean {
  const byParent = childrenByParent(rows);
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue; // defensive: ps snapshots can contain cycles after reparenting
      seen.add(child.pid);
      if (!isShellCommand(child.command)) return true;
      queue.push(child.pid);
    }
  }
  return false;
}

/** Whether `rootPid`'s tree currently runs something other than shells. */
function hasRunningService(rootPid: number): boolean {
  return hasNonShellDescendant(snapshotProcessTable(), rootPid);
}

export {
  hasNonShellDescendant,
  hasRunningService,
  isShellCommand,
  parseProcessTable,
  snapshotProcessTable,
};
export type { ProcessRow };
