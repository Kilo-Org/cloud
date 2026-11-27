import { gitBlobSha } from '../../src/github';

/**
 * A small in-memory GitHub: commits with real git blob ids and made-up tree and commit ids, a
 * parent chain for compare, merged PRs per commit and reviews per PR. It answers the REST calls
 * `src/github.ts` makes, and counts them.
 */

type Tree = Map<string, { type: 'blob' | 'tree'; sha: string }>;

export type FakeCommit = { sha: string; parent: string | null; root: string };

export type FakePull = {
  number: number;
  mergedAt: string | null;
  baseRef: string;
  authorId: number;
};

export type FakeReview = {
  userId: number;
  login?: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  commitId: string;
};

let counter = 0;
/** A unique made-up 40-hex id: `c…` for commits, `e…` for trees. */
function fakeSha(kind: 'commit' | 'tree'): string {
  counter += 1;
  return counter.toString(16).padStart(40, kind === 'commit' ? 'c' : 'e');
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class FakeGithub {
  readonly blobs = new Map<string, Uint8Array>();
  readonly trees = new Map<string, Tree>();
  readonly commits = new Map<string, FakeCommit>();
  readonly files = new Map<string, Map<string, string>>();
  readonly pulls = new Map<string, FakePull[]>();
  readonly reviews = new Map<number, FakeReview[]>();
  /**
   * `commits?sha=&path=` answers set by hand, keyed `<sha>:<path>`: for a merge commit GitHub's
   * path history names the branch commit, which this fake's first-parent walk cannot.
   */
  readonly touching = new Map<string, string>();
  main: string | null = null;
  calls: string[] = [];
  /** Answers instead of the repository while set: a status code, with headers. */
  outage: { status: number; headers?: Record<string, string> } | null = null;
  /** Fails `blob` fetches after this many succeeded, to exercise resumable fetches. */
  blobBudget: number | null = null;

  /** Adds a commit with exactly `files` (path → text) on top of `parent`. */
  async commit(files: Record<string, string>, parent: string | null): Promise<string> {
    const blobIds = new Map<string, string>();
    for (const [path, text] of Object.entries(files)) {
      const bytes = new TextEncoder().encode(text);
      const sha = await gitBlobSha(bytes);
      this.blobs.set(sha, bytes);
      blobIds.set(path, sha);
    }
    const root = this.buildTree('', blobIds);
    const sha = fakeSha('commit');
    this.commits.set(sha, { sha, parent, root });
    this.files.set(sha, blobIds);
    return sha;
  }

  /** A commit on `main`: it becomes main's head. */
  async push(files: Record<string, string>): Promise<string> {
    const sha = await this.commit(files, this.main);
    this.main = sha;
    return sha;
  }

  blobOf(commit: string, path: string): string | null {
    return this.files.get(commit)?.get(path) ?? null;
  }

  private buildTree(prefix: string, blobIds: Map<string, string>): string {
    const tree: Tree = new Map();
    const subdirs = new Set<string>();
    for (const [path, sha] of blobIds) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) tree.set(rest, { type: 'blob', sha });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const dir of subdirs) {
      tree.set(dir, { type: 'tree', sha: this.buildTree(`${prefix}${dir}/`, blobIds) });
    }
    const key = JSON.stringify([...tree].sort(([a], [b]) => a.localeCompare(b)));
    for (const [sha, existing] of this.trees) {
      if (JSON.stringify([...existing].sort(([a], [b]) => a.localeCompare(b))) === key) return sha;
    }
    const sha = fakeSha('tree');
    this.trees.set(sha, tree);
    return sha;
  }

  private isAncestor(ancestor: string, of: string): boolean {
    for (let at: string | null = of; at !== null; at = this.commits.get(at)?.parent ?? null) {
      if (at === ancestor) return true;
    }
    return false;
  }

  private resolve(ref: string): string {
    return ref === 'main' && this.main !== null ? this.main : ref;
  }

  /** The newest commit on `sha`'s history whose blob at `path` differs from its parent's. */
  private lastTouching(sha: string, path: string): string | null {
    for (let at: string | null = sha; at !== null; at = this.commits.get(at)?.parent ?? null) {
      const parent = this.commits.get(at)?.parent ?? null;
      const before = parent === null ? null : this.blobOf(parent, path);
      if (this.blobOf(at, path) !== before) return at;
    }
    return null;
  }

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    this.calls.push(`${init.method ?? 'GET'} ${url.pathname}`);
    if (this.outage !== null) {
      return new Response('{}', { status: this.outage.status, headers: this.outage.headers });
    }
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const notFound = () => json({ message: 'Not Found' }, 404);
    if (
      init.method === 'POST' &&
      /^\/app\/installations\/[0-9]+\/access_tokens$/.test(url.pathname)
    ) {
      return json(
        { token: 'ghs_fake', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        201
      );
    }
    const repo = '/repos/Kilo-Org/cloud';
    if (!url.pathname.startsWith(repo)) return notFound();
    const path = url.pathname.slice(repo.length);
    let match: RegExpExecArray | null;
    if ((match = /^\/compare\/([^.]+)\.\.\.(.+)$/.exec(path))) {
      const base = this.resolve(match[1]);
      const head = this.resolve(match[2]);
      if (!this.commits.has(base) || !this.commits.has(head)) return notFound();
      const status =
        base === head
          ? 'identical'
          : this.isAncestor(base, head)
            ? 'ahead'
            : this.isAncestor(head, base)
              ? 'behind'
              : 'diverged';
      return json({ status });
    }
    if ((match = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path))) {
      const treeSha = this.commits.get(match[1])?.root ?? match[1];
      const tree = this.trees.get(treeSha);
      if (tree === undefined) return notFound();
      return json({
        sha: treeSha,
        truncated: false,
        tree: [...tree].map(([name, entry]) => ({ path: name, type: entry.type, sha: entry.sha })),
      });
    }
    if ((match = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path))) {
      const bytes = this.blobs.get(match[1]);
      if (bytes === undefined) return notFound();
      if (this.blobBudget !== null) {
        if (this.blobBudget <= 0) return json({ message: 'boom' }, 502);
        this.blobBudget -= 1;
      }
      return json({ encoding: 'base64', content: base64(bytes), size: bytes.byteLength });
    }
    if (path === '/commits') {
      const sha = url.searchParams.get('sha') ?? '';
      const filePath = url.searchParams.get('path') ?? '';
      const touching = this.touching.get(`${sha}:${filePath}`) ?? this.lastTouching(sha, filePath);
      return json(touching === null ? [] : [{ sha: touching }]);
    }
    if ((match = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(path))) {
      return json(
        (this.pulls.get(match[1]) ?? []).map(pull => ({
          number: pull.number,
          merged_at: pull.mergedAt,
          base: { ref: pull.baseRef },
          user: { id: pull.authorId },
        }))
      );
    }
    if ((match = /^\/pulls\/([0-9]+)\/reviews$/.exec(path))) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      const all = this.reviews.get(Number(match[1])) ?? [];
      return json(
        all.slice((page - 1) * perPage, page * perPage).map(review => ({
          user: { id: review.userId, login: review.login ?? `user${review.userId}` },
          state: review.state,
          commit_id: review.commitId,
        }))
      );
    }
    if ((match = /^\/contents\/(.+)$/.exec(path))) {
      const ref = url.searchParams.get('ref') ?? '';
      const blob = this.blobOf(ref, decodeURIComponent(match[1]));
      return blob === null ? notFound() : json({ type: 'file', sha: blob });
    }
    return notFound();
  };
}
