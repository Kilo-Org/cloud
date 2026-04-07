import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { logToFile } from './utils.js';
import type { RestoreResult } from './restore-session.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type CloneOpts = {
  url: string;
  targetDir: string;
};

type CheckoutBranchOpts = {
  workspacePath: string;
  branchName: string;
  isUpstreamBranch: boolean;
};

type SetupCommandOpts = {
  workspacePath: string;
  commands: string[];
};

type WriteAuthOpts = {
  sessionHome: string;
  kilocodeToken: string;
};

type ImportSessionOpts = {
  kiloSessionId: string;
  workspacePath: string;
  snapshotUrl?: string;
};

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

async function spawn(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): Promise<SpawnResult> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Git helpers (local equivalents of workspace.ts helpers)
// ---------------------------------------------------------------------------

const GITHUB_PULL_REF_PATTERN = /^refs\/pull\/\d+\/head$/;

async function gitFetch(workspacePath: string): Promise<void> {
  const result = await spawn('git', ['fetch', 'origin'], { cwd: workspacePath });
  if (result.exitCode !== 0) {
    logToFile(`[workspace-setup] git fetch warning: ${result.stderr.trim()}`);
  }
}

async function branchExistsLocally(workspacePath: string, branchName: string): Promise<boolean> {
  const result = await spawn('git', ['rev-parse', '--verify', branchName], { cwd: workspacePath });
  return result.exitCode === 0;
}

async function branchExistsRemotely(workspacePath: string, branchName: string): Promise<boolean> {
  const result = await spawn('git', ['rev-parse', '--verify', `origin/${branchName}`], {
    cwd: workspacePath,
  });
  return result.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function cloneRepo(opts: CloneOpts): Promise<void> {
  const { url, targetDir } = opts;
  logToFile(`[workspace-setup] cloneRepo targetDir=${targetDir}`);

  const result = await spawn('git', ['clone', url, targetDir]);
  if (result.exitCode !== 0) {
    throw new Error(`cloneRepo failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }

  logToFile('[workspace-setup] cloneRepo completed');
}

export async function checkoutBranch(opts: CheckoutBranchOpts): Promise<string> {
  const { workspacePath, branchName, isUpstreamBranch } = opts;
  logToFile(`[workspace-setup] checkoutBranch branch=${branchName} isUpstream=${isUpstreamBranch}`);

  await gitFetch(workspacePath);

  const [existsLocally, existsRemotely] = await Promise.all([
    branchExistsLocally(workspacePath, branchName),
    branchExistsRemotely(workspacePath, branchName),
  ]);

  logToFile(`[workspace-setup] branch status: local=${existsLocally} remote=${existsRemotely}`);

  if (existsLocally && existsRemotely) {
    // Case 1: Exists in both — checkout and optionally pull
    const co = await spawn('git', ['checkout', branchName], { cwd: workspacePath });
    if (co.exitCode !== 0) {
      throw new Error(`checkoutBranch: checkout failed (exit ${co.exitCode}): ${co.stderr.trim()}`);
    }
    if (!isUpstreamBranch) {
      const pull = await spawn('git', ['pull', 'origin', branchName], { cwd: workspacePath });
      if (pull.exitCode !== 0) {
        logToFile(`[workspace-setup] pull warning (continuing with local): ${pull.stderr.trim()}`);
      }
    }
  } else if (existsLocally) {
    // Case 2: Only local — just checkout
    const co = await spawn('git', ['checkout', branchName], { cwd: workspacePath });
    if (co.exitCode !== 0) {
      throw new Error(`checkoutBranch: checkout failed (exit ${co.exitCode}): ${co.stderr.trim()}`);
    }
  } else if (existsRemotely) {
    // Case 3: Only remote — create tracking branch
    const co = await spawn('git', ['checkout', '-b', branchName, `origin/${branchName}`], {
      cwd: workspacePath,
    });
    if (co.exitCode !== 0) {
      throw new Error(
        `checkoutBranch: create tracking branch failed (exit ${co.exitCode}): ${co.stderr.trim()}`
      );
    }
  } else {
    // Case 4: Doesn't exist anywhere
    if (isUpstreamBranch) {
      if (GITHUB_PULL_REF_PATTERN.test(branchName)) {
        const fetchRef = await spawn('git', ['fetch', 'origin', branchName], {
          cwd: workspacePath,
        });
        if (fetchRef.exitCode !== 0) {
          throw new Error(
            `checkoutBranch: fetch pull ref failed (exit ${fetchRef.exitCode}): ${fetchRef.stderr.trim()}`
          );
        }
        const co = await spawn('git', ['checkout', '-B', branchName, 'FETCH_HEAD'], {
          cwd: workspacePath,
        });
        if (co.exitCode !== 0) {
          throw new Error(
            `checkoutBranch: checkout pull ref failed (exit ${co.exitCode}): ${co.stderr.trim()}`
          );
        }
        logToFile(`[workspace-setup] checked out GitHub pull ref ${branchName}`);
        return branchName;
      }
      throw new Error(
        `Branch "${branchName}" not found in repository. Please ensure the branch exists remotely.`
      );
    }
    const co = await spawn('git', ['checkout', '-b', branchName], { cwd: workspacePath });
    if (co.exitCode !== 0) {
      throw new Error(
        `checkoutBranch: create branch failed (exit ${co.exitCode}): ${co.stderr.trim()}`
      );
    }
  }

  logToFile('[workspace-setup] checkoutBranch completed');
  return branchName;
}

export async function runSetupCommands(opts: SetupCommandOpts): Promise<void> {
  const { workspacePath, commands } = opts;
  logToFile(`[workspace-setup] runSetupCommands count=${commands.length}`);

  for (const command of commands) {
    logToFile(`[workspace-setup] running: ${command}`);
    const result = await spawn('sh', ['-c', command], { cwd: workspacePath });
    if (result.exitCode !== 0) {
      throw new Error(
        `runSetupCommands: command failed (exit ${result.exitCode}): ${command}\n${result.stderr.trim()}`
      );
    }
  }

  logToFile('[workspace-setup] runSetupCommands completed');
}

export function writeAuthFile(opts: WriteAuthOpts): void {
  const { sessionHome, kilocodeToken } = opts;
  logToFile(`[workspace-setup] writeAuthFile sessionHome=${sessionHome}`);

  const authDir = join(sessionHome, '.kilo');
  const authPath = join(authDir, 'auth.json');

  mkdirSync(authDir, { recursive: true });
  writeFileSync(authPath, JSON.stringify({ token: kilocodeToken }));

  logToFile('[workspace-setup] writeAuthFile completed');
}

export async function importSession(opts: ImportSessionOpts): Promise<RestoreResult> {
  const { kiloSessionId, workspacePath, snapshotUrl } = opts;
  logToFile(`[workspace-setup] importSession id=${kiloSessionId} hasSnapshot=${!!snapshotUrl}`);

  if (snapshotUrl) {
    // Download snapshot, then use the restore-session module via subprocess
    const tmpPath = `/tmp/kilo-session-export-${kiloSessionId}.json`;

    logToFile('[workspace-setup] downloading snapshot');
    const res = await fetch(snapshotUrl, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) {
      throw new Error(`importSession: snapshot download failed (status ${res.status})`);
    }
    await Bun.write(tmpPath, res);
    logToFile('[workspace-setup] snapshot downloaded');

    try {
      const result = await spawn('bun', [
        '/usr/local/bin/kilo-restore-session.js',
        '--file',
        tmpPath,
        kiloSessionId,
        workspacePath,
      ]);

      if (result.exitCode !== 0) {
        const parsed = tryParseJson<RestoreResult>(result.stdout);
        if (parsed) return parsed;
        throw new Error(
          `importSession: restore-session failed (exit ${result.exitCode}): ${result.stderr.trim()}`
        );
      }

      const parsed = tryParseJson<RestoreResult>(result.stdout);
      if (parsed) return parsed;
      return {
        ok: true,
        downloaded: true,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      };
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }

  // No snapshot URL — create a minimal session and run the restore script
  const tmpPath = `/tmp/kilo-session-minimal-${kiloSessionId}.json`;
  writeFileSync(tmpPath, JSON.stringify({ sessionId: kiloSessionId }));

  try {
    const result = await spawn('bun', [
      '/usr/local/bin/kilo-restore-session.js',
      '--file',
      tmpPath,
      kiloSessionId,
      workspacePath,
    ]);

    if (result.exitCode !== 0) {
      const parsed = tryParseJson<RestoreResult>(result.stdout);
      if (parsed) return parsed;
      throw new Error(
        `importSession: restore-session failed (exit ${result.exitCode}): ${result.stderr.trim()}`
      );
    }

    const parsed = tryParseJson<RestoreResult>(result.stdout);
    if (parsed) return parsed;
    logToFile('[workspace-setup] importSession completed');
    return {
      ok: true,
      downloaded: false,
      imported: true,
      diffs: { applied: 0, skipped: 0, total: 0 },
    };
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tryParseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    return undefined;
  }
}
