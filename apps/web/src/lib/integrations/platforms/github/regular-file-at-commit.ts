import { Octokit } from '@octokit/rest';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_FILE_BYTES = 1_000_000;
const REGULAR_FILE_MODES = new Set(['100644', '100755']);

type TreeEntry = { path?: string; mode?: string; type?: string; sha?: string; size?: number };

/**
 * Reads a file by walking Git trees from a commit and then reading its blob by SHA.
 * The contents API follows symlinks, so a `*.md` symlink could return any file. This
 * walk never follows them: a symlink on the path, a submodule, or a directory returns null.
 */
export async function fetchGitHubRegularFileAtCommit(params: {
  token: string;
  owner: string;
  repo: string;
  commitSha: string;
  path: string;
}): Promise<string | null> {
  const { token, owner, repo, commitSha, path } = params;
  const octokit = new Octokit({ auth: token });
  const findEntry = async (treeSha: string, name: string): Promise<TreeEntry | undefined> => {
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: treeSha,
      request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    });
    const entry = data.tree.find(item => item.path === name);
    if (!entry && data.truncated) throw new Error('GitHub tree listing truncated');
    return entry;
  };

  const directories = path.split('/');
  const fileName = directories.pop();
  if (!fileName) return null;

  try {
    let treeSha = commitSha;
    for (const name of directories) {
      const entry = await findEntry(treeSha, name);
      if (entry?.type !== 'tree' || !entry.sha) return null;
      treeSha = entry.sha;
    }

    const file = await findEntry(treeSha, fileName);
    if (
      file?.type !== 'blob' ||
      !file.sha ||
      !REGULAR_FILE_MODES.has(file.mode ?? '') ||
      (file.size ?? Infinity) > MAX_FILE_BYTES
    ) {
      return null;
    }

    const { data } = await octokit.git.getBlob({
      owner,
      repo,
      file_sha: file.sha,
      request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    });
    if (data.encoding !== 'base64') return null;
    return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
      return null;
    }
    throw error;
  }
}
