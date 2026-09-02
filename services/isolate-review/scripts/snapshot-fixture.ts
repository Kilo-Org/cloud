import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_CLONE_URL = 'https://github.com/tj/commander.js.git';
const SOURCE_REPOSITORY = 'tj/commander.js';
const HEAD_SHA = 'c635fad50bbe19b28cb3f68719f832c73cafe30f';
const BASE_SHA = '201d93249b1d38c0d1b3b5960865fdf4f84990b9';
const OWNER = 'kilo-e2e';
const REPO = 'review-fixture';
const PULL_NUMBER = 1;

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const githubDir = join(fixturesDir, 'github');

type NameStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed';

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function statusFromCode(code: string): NameStatus {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'removed';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'changed';
    default:
      return 'modified';
  }
}

function parseNameStatus(line: string): { filename: string; status: NameStatus } | undefined {
  const [code, fromPath, toPath] = line.split('\t');
  if (!code || !fromPath) return undefined;
  const status = statusFromCode(code);
  const filename = status === 'renamed' || status === 'copied' ? (toPath ?? fromPath) : fromPath;
  return { filename, status };
}

function parseNumstat(
  line: string
): { filename: string; additions: number; deletions: number } | undefined {
  const [addRaw, delRaw, ...rest] = line.split('\t');
  if (addRaw === undefined || delRaw === undefined || rest.length === 0) return undefined;
  let filename = rest.join('\t');
  if (filename.includes(' => ')) {
    const parts = filename.split(' => ');
    filename = parts[parts.length - 1] ?? filename;
  }
  const additions = addRaw === '-' ? 0 : Number(addRaw);
  const deletions = delRaw === '-' ? 0 : Number(delRaw);
  if (!Number.isFinite(additions) || !Number.isFinite(deletions)) return undefined;
  return { filename, additions, deletions };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveSourceRepo(): { cwd: string; cleanup?: () => void } {
  const existing = process.argv[2];
  if (existing) return { cwd: existing };
  const dir = mkdtempSync(join(tmpdir(), 'isolate-review-fixture-'));
  git(['clone', '--quiet', SOURCE_CLONE_URL, dir]);
  return { cwd: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function snapshot(): void {
  const source = resolveSourceRepo();
  try {
    const head = git(['rev-parse', HEAD_SHA], source.cwd);
    const base = git(['rev-parse', BASE_SHA], source.cwd);
    if (head !== HEAD_SHA || base !== BASE_SHA) {
      throw new Error('Pinned source commits are not present in the clone');
    }

    const title = git(['log', '-1', '--format=%s', HEAD_SHA], source.cwd);
    const commitBody = git(['log', '-1', '--format=%b', HEAD_SHA], source.cwd).trim();
    const body =
      commitBody || 'Collect variadic option and argument values with push, and add tests.';
    const treeBytes = git(['ls-tree', '-r', '-l', HEAD_SHA], source.cwd)
      .split('\n')
      .reduce((sum, line) => {
        const size = Number(line.split(/\s+/)[3]);
        return Number.isFinite(size) ? sum + size : sum;
      }, 0);
    const sizeKiB = Math.max(1, Math.ceil(treeBytes / 1024));

    const nameStatus = git(['diff', '--name-status', `${BASE_SHA}...${HEAD_SHA}`], source.cwd)
      .split('\n')
      .filter(Boolean)
      .map(parseNameStatus)
      .filter((row): row is { filename: string; status: NameStatus } => row !== undefined);
    const numstat = new Map(
      git(['diff', '--numstat', `${BASE_SHA}...${HEAD_SHA}`], source.cwd)
        .split('\n')
        .filter(Boolean)
        .map(parseNumstat)
        .filter(
          (row): row is { filename: string; additions: number; deletions: number } =>
            row !== undefined
        )
        .map(row => [row.filename, row])
    );
    const files = nameStatus.map(row => {
      const stats = numstat.get(row.filename);
      const additions = stats?.additions ?? 0;
      const deletions = stats?.deletions ?? 0;
      return {
        filename: row.filename,
        status: row.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });

    const diff = git(['diff', `${BASE_SHA}...${HEAD_SHA}`], source.cwd);
    if (!diff.includes('diff --git')) {
      throw new Error('Expected a unified diff from the pinned commit range');
    }

    const bare = mkdtempSync(join(tmpdir(), 'isolate-review-bundle-'));
    try {
      git(['init', '--bare', bare]);
      git(
        [
          '--git-dir',
          bare,
          'fetch',
          '--quiet',
          source.cwd,
          `${HEAD_SHA}:refs/heads/pr-head`,
          `${BASE_SHA}:refs/heads/base`,
        ],
        source.cwd
      );
      mkdirSync(githubDir, { recursive: true });
      git([
        '--git-dir',
        bare,
        'bundle',
        'create',
        join(fixturesDir, 'review-fixture.bundle'),
        'pr-head',
        'base',
      ]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }

    writeJson(join(githubDir, 'repo.json'), { size: sizeKiB });
    writeJson(join(githubDir, 'pull.json'), {
      title,
      body,
      user: { login: 'e2e' },
      base: { ref: 'base', sha: BASE_SHA },
      head: { ref: 'pr-head', sha: HEAD_SHA },
      state: 'open',
      draft: false,
    });
    writeFileSync(join(githubDir, 'pull.diff'), diff.endsWith('\n') ? diff : `${diff}\n`);
    writeJson(join(githubDir, 'files.json'), files);
    writeJson(join(githubDir, 'comments.json'), []);
    writeJson(join(githubDir, 'issue-comments.json'), []);
    writeJson(join(githubDir, 'reviews.json'), []);
    writeJson(join(fixturesDir, 'meta.json'), {
      owner: OWNER,
      repo: REPO,
      pullNumber: PULL_NUMBER,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      source: { repository: SOURCE_REPOSITORY, cloneUrl: SOURCE_CLONE_URL },
    });
  } finally {
    source.cleanup?.();
  }
}

snapshot();
