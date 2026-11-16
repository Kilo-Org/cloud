import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorktreeRecovery } from '../../../src/shared/worktree-changes-wire.js';
import type { RestoreDiffSkip } from '../restore-session.js';
import { agentCommand, agentOwns, writeAgentFile } from '../control/agent-execution.js';

const exec = promisify(execFile);

export async function restoreWorktreeRecovery(
  directory: string,
  recovery: WorktreeRecovery,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
) {
  const root = await fs.realpath(path.resolve(directory));
  const skippedDiffs: RestoreDiffSkip[] = [];
  let applied = 0;
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-worktree-recovery-'));
  await agentOwns(temporary);
  const patchFile = path.join(temporary, 'change.patch');
  const git = (args: string[]) => {
    const child = agentCommand('git', args, env);
    return exec(child.command, child.args, {
      cwd: root,
      env: child.env,
      signal,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  };
  try {
    for (const file of recovery.files) {
      let reason: RestoreDiffSkip['reason'] = 'patch_apply_failed';
      try {
        signal.throwIfAborted();
        const parts = file.path.split('/');
        if (
          path.isAbsolute(file.path) ||
          file.path.includes('\\') ||
          file.path.includes('\0') ||
          parts.some(
            part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'
          )
        ) {
          reason = 'outside_workspace';
          throw new Error('Unsafe recovery path');
        }
        let parent = root;
        for (const part of parts) {
          parent = path.join(parent, part);
          const stat = await fs.lstat(parent).catch((error: unknown) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
              return undefined;
            throw error;
          });
          if (stat?.isSymbolicLink()) throw new Error('Symlink recovery path');
        }
        if (!file.patch) {
          reason = 'missing_content';
          throw new Error('No recovery patch');
        }
        if (
          /^(?:old mode|new mode|new file mode|deleted file mode|index .*?) (?:120000|160000)$/m.test(
            file.patch
          )
        ) {
          reason = 'outside_workspace';
          throw new Error('Unsupported recovery file mode');
        }
        await writeAgentFile(patchFile, file.patch, 0o600);
        const { stdout } = await git(['apply', '--numstat', '-z', patchFile]);
        const entries = stdout.split('\0').filter(Boolean);
        if (entries.length !== 1 || entries[0].split('\t').slice(2).join('\t') !== file.path) {
          reason = 'outside_workspace';
          throw new Error('Recovery patch changes another path');
        }
        const alreadyApplied = await git([
          'apply',
          '--reverse',
          '--check',
          '--whitespace=nowarn',
          patchFile,
        ]).then(
          () => true,
          () => false
        );
        if (!alreadyApplied) {
          await git(['apply', '--check', '--whitespace=nowarn', patchFile]);
          await git(['apply', '--whitespace=nowarn', patchFile]);
        }
        applied++;
        continue;
      } catch {
        if (skippedDiffs.length < 100) skippedDiffs.push({ file: file.path, reason });
      }
    }
    return {
      applied,
      skipped: recovery.files.length - applied,
      total: recovery.files.length,
      skippedDiffs,
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
