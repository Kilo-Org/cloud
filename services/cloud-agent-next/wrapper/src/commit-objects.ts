import { git, type GitOptions } from './utils.js';
import { decodeWorktreeUtf8 } from './control/worktree-file-capture.js';

export const FULL_COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const MAX_COMMIT_MESSAGE_BYTES = 16 * 1024;
const MAX_COMMIT_HEADER_BYTES = 64 * 1024;

export function immutableGit(
  directory: string,
  args: string[],
  options: Pick<GitOptions, 'timeoutMs' | 'signal' | 'maxOutputBytes'>,
  runGit: typeof git = git
) {
  return runGit(
    [
      '--no-pager',
      '--no-optional-locks',
      '-c',
      'color.ui=false',
      '-c',
      'core.quotepath=false',
      '-c',
      'core.fsmonitor=false',
      ...args,
    ],
    {
      cwd: directory,
      inheritEnv: false,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
      terminationGraceMs: 250,
      rawOutput: true,
      ...options,
    }
  );
}

export type CommitObject = {
  commitMessage: string;
  committedAt: string;
  commitMessageTruncated?: true;
};

export async function readCommitObject(
  directory: string,
  commitHash: string,
  options: Pick<GitOptions, 'timeoutMs' | 'signal'>,
  runGit: typeof git = git
): Promise<CommitObject> {
  if (!FULL_COMMIT_HASH.test(commitHash)) throw new Error('Invalid commit hash');
  const result = await immutableGit(
    directory,
    ['cat-file', 'commit', commitHash],
    { ...options, maxOutputBytes: MAX_COMMIT_HEADER_BYTES + MAX_COMMIT_MESSAGE_BYTES + 1 },
    runGit
  );
  const bytes = result.stdoutBytes;
  if (result.exitCode !== 0 || result.terminationReason || !bytes) {
    throw new Error('Commit metadata unavailable');
  }
  const separator = bytes.indexOf('\n\n');
  if (separator < 0 || separator > MAX_COMMIT_HEADER_BYTES) {
    throw new Error('Commit metadata unavailable');
  }
  const headers = decodeWorktreeUtf8(bytes.subarray(0, separator)).split('\n');
  const committer = headers.find(line => line.startsWith('committer '));
  const timestamp = committer && / (-?\d+) [+-]\d{4}$/.exec(committer)?.[1];
  if (!timestamp) throw new Error('Commit metadata unavailable');
  const committedAt = new Date(Number(timestamp) * 1000).toISOString();
  const message = bytes.subarray(separator + 2);
  const truncated = result.stdoutTruncated || message.length > MAX_COMMIT_MESSAGE_BYTES;
  let end = Math.min(message.length, MAX_COMMIT_MESSAGE_BYTES);
  if (truncated) {
    while (end > 0 && (message[end] & 0xc0) === 0x80) end -= 1;
  }
  return {
    committedAt,
    commitMessage: decodeWorktreeUtf8(message.subarray(0, end)),
    ...(truncated ? { commitMessageTruncated: true } : {}),
  };
}
