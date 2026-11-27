// A fake GitHub REST API over a local git repository, for the local e2e (contract §10 step 5).
// It answers the calls src/github.ts makes. Every commit counts as the squash merge of one PR into
// main, approved by a pinned code owner (eshurakov, 54751) at that commit, so the owner-approval
// check passes for whatever the repository holds.
// Usage: node fake-github.mjs <repo dir> <port>
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const [repo, port] = process.argv.slice(2);
const OWNER_ID = 54751;
const AUTHOR_ID = 99001;
const git = (...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: 1 << 28 });
const gitText = (...args) =>
  git(...args)
    .toString('utf8')
    .trim();
const tryGit = (...args) => {
  try {
    return gitText(...args);
  } catch {
    return null;
  }
};
const resolve = ref =>
  tryGit('rev-parse', '--verify', '--quiet', `${ref === 'main' ? 'main' : ref}^{commit}`);
const prOf = new Map();

function answer(method, url) {
  const path = url.pathname;
  if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
    return [
      201,
      { token: 'ghs_fake_e2e', expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    ];
  }
  const prefix = '/repos/Kilo-Org/cloud';
  if (!path.startsWith(prefix)) return [404, { message: 'Not Found' }];
  const rest = path.slice(prefix.length);
  let match;
  if ((match = /^\/compare\/([^.]+)\.\.\.(.+)$/.exec(rest))) {
    const base = resolve(match[1]);
    const head = resolve(match[2]);
    if (base === null || head === null) return [404, { message: 'Not Found' }];
    const ancestor = (a, b) => tryGit('merge-base', '--is-ancestor', a, b) !== null;
    const status =
      base === head
        ? 'identical'
        : ancestor(base, head)
          ? 'ahead'
          : ancestor(head, base)
            ? 'behind'
            : 'diverged';
    return [200, { status }];
  }
  if ((match = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest))) {
    const listing = tryGit('ls-tree', match[1]);
    if (listing === null) return [404, { message: 'Not Found' }];
    const tree = listing
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [meta, name] = line.split('\t');
        const [, type, sha] = meta.split(' ');
        return { path: name, type, sha };
      });
    return [200, { sha: match[1], truncated: false, tree }];
  }
  if ((match = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest))) {
    const bytes = git('cat-file', 'blob', match[1]);
    return [200, { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length }];
  }
  if (rest === '/commits') {
    const sha = url.searchParams.get('sha');
    const file = url.searchParams.get('path');
    const commit = tryGit('log', '-n', '1', '--format=%H', sha, '--', file);
    return [200, commit ? [{ sha: commit }] : []];
  }
  if ((match = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(rest))) {
    const number = parseInt(match[1].slice(0, 6), 16);
    prOf.set(number, match[1]);
    return [
      200,
      [
        {
          number,
          merged_at: '2026-11-27T00:00:00Z',
          base: { ref: 'main' },
          user: { id: AUTHOR_ID },
        },
      ],
    ];
  }
  if ((match = /^\/pulls\/(\d+)\/reviews$/.exec(rest))) {
    const commit = prOf.get(Number(match[1]));
    const page = Number(url.searchParams.get('page') ?? '1');
    if (commit === undefined || page > 1) return [200, []];
    return [
      200,
      [{ user: { id: OWNER_ID, login: 'eshurakov' }, state: 'APPROVED', commit_id: commit }],
    ];
  }
  if ((match = /^\/contents\/(.+)$/.exec(rest))) {
    const sha = tryGit(
      'rev-parse',
      '--verify',
      '--quiet',
      `${url.searchParams.get('ref')}:${decodeURIComponent(match[1])}`
    );
    return sha === null ? [404, { message: 'Not Found' }] : [200, { type: 'file', sha }];
  }
  return [404, { message: 'Not Found' }];
}

let calls = 0;
createServer((request, response) => {
  calls += 1;
  const [status, body] = answer(request.method, new URL(request.url, 'http://fake'));
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}).listen(Number(port), '127.0.0.1', () => console.log(`fake github on ${port} for ${repo}`));
setInterval(() => console.log(`calls=${calls}`), 60_000).unref();
