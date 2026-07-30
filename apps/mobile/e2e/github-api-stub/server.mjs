#!/usr/bin/env node
/**
 * Hermetic local GitHub API stub for mobile PR-review E2E.
 * Node built-ins only. Logs every request; GraphQL logs operation name + variables.
 *
 * Identities:
 *   kilo-stub/discussion-mixed#1              — interleaved review + conversation fixture
 *   kilo-stub/discussion-conversation-only#2  — conversation comments only (0 review threads)
 *   kilo-stub/discussion-empty#3              — empty discussion
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GITHUB_STUB_PORT || process.argv[2] || 0);
const LOG_PATH =
  process.env.GITHUB_STUB_LOG || path.join(process.cwd(), 'github-api-stub-requests.log');

const T0 = '2026-03-01T12:00:00.000Z';
// Interleaved timeline (T+minutes from T0):
// T+1 threadA c1, T+2 conv1, T+3 conv2, T+4 threadB c1, T+5 threadA c2, T+6 conv3
const ts = minutes => {
  const d = new Date(T0);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
};

const AVATAR = 'https://avatars.githubusercontent.com/u/1?v=4';
const author = login => ({ login, avatarUrl: AVATAR });
const restUser = login => ({
  login,
  id: 1,
  node_id: 'U_stub',
  avatar_url: AVATAR,
  html_url: `https://github.com/${login}`,
  type: 'User',
  site_admin: false,
});

const reactionGroups = () =>
  ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'].map(
    content => ({
      content,
      viewerHasReacted: false,
      reactors: { totalCount: 0 },
    })
  );

/** GraphQL IssueComment node for pullRequest.comments (PrReviewConversationComments). */
const conversationComment = (databaseId, login, body, minutes) => ({
  id: `IC_stub_${databaseId}`,
  databaseId,
  author: author(login),
  body,
  createdAt: ts(minutes),
  reactionGroups: reactionGroups(),
});

/** REST pull-request file entry (GET /repos/{owner}/{repo}/pulls/{n}/files shape). */
const prFile = (filename, additions, deletions, patch) => ({
  sha: 'cccccccccccccccccccccccccccccccccccccccc',
  filename,
  status: 'modified',
  additions,
  deletions,
  changes: additions + deletions,
  blob_url: `https://github.com/kilo-stub/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${filename}`,
  raw_url: `https://github.com/kilo-stub/raw/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${filename}`,
  contents_url: `https://api.github.com/repos/kilo-stub/contents/${filename}?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
  patch,
});

// Two files per fixture, matching restPull's changed_files: 2 / additions: 10 / deletions: 2.
const stubFiles = () => [
  prFile(
    'src/alpha.ts',
    6,
    1,
    '@@ -8,4 +8,9 @@ export function alpha() {\n-  return 1;\n+  // stub change\n+  return 2;\n+}\n+\n+export function alphaExtra() {\n+  return 3;\n }'
  ),
  prFile(
    'src/beta.ts',
    4,
    1,
    '@@ -18,3 +18,6 @@ export function beta() {\n-  return 1;\n+  return 2;\n+}\n+\n+export function betaExtra() {\n+  return 3;\n }'
  ),
];

/** @type {Record<string, object>} */
const FIXTURES = {
  'kilo-stub/discussion-mixed/1': {
    title: 'Mixed discussion fixture',
    body: 'PR body for mixed fixture.',
    files: stubFiles(),
    threads: [
      {
        id: 'PRRT_thread_a',
        isResolved: false,
        isOutdated: false,
        subjectType: 'LINE',
        path: 'src/alpha.ts',
        line: 10,
        startLine: 10,
        originalLine: 10,
        originalStartLine: 10,
        diffSide: 'RIGHT',
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              databaseId: 1001,
              id: 'PRRC_a1',
              body: 'Thread A comment at T+1 (inline review)',
              createdAt: ts(1),
              author: author('alice'),
              reactionGroups: reactionGroups(),
            },
            {
              databaseId: 1005,
              id: 'PRRC_a2',
              body: 'Thread A reply at T+5 (inline review)',
              createdAt: ts(5),
              author: author('bob'),
              reactionGroups: reactionGroups(),
            },
          ],
        },
      },
      {
        id: 'PRRT_thread_b',
        isResolved: false,
        isOutdated: false,
        subjectType: 'LINE',
        path: 'src/beta.ts',
        line: 20,
        startLine: 20,
        originalLine: 20,
        originalStartLine: 20,
        diffSide: 'RIGHT',
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              databaseId: 1004,
              id: 'PRRC_b1',
              body: 'Thread B comment at T+4 (inline review)',
              createdAt: ts(4),
              author: author('carol'),
              reactionGroups: reactionGroups(),
            },
          ],
        },
      },
    ],
    // GraphQL pullRequest.comments nodes. REST issues/{n}/comments is intentionally
    // not served — S2 reads conversation comments over GraphQL only.
    conversationComments: [
      conversationComment(2002, 'dave', 'Conversation comment at T+2', 2),
      conversationComment(2003, 'erin', 'Conversation comment at T+3', 3),
      conversationComment(2006, 'frank', 'Conversation comment at T+6', 6),
    ],
  },
  'kilo-stub/discussion-conversation-only/2': {
    title: 'Conversation-only fixture',
    body: 'PR body for conversation-only fixture.',
    files: stubFiles(),
    threads: [],
    conversationComments: [
      conversationComment(3001, 'dave', 'Only conversation comment one', 2),
      conversationComment(3002, 'erin', 'Only conversation comment two', 6),
    ],
  },
  'kilo-stub/discussion-empty/3': {
    title: 'Empty discussion fixture',
    body: 'PR body for empty fixture.',
    files: stubFiles(),
    threads: [],
    conversationComments: [],
  },
};

function logLine(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  fs.appendFileSync(LOG_PATH, line + '\n');
  console.log(line);
}

function parseOpName(query) {
  if (typeof query !== 'string') return null;
  const m = query.match(/\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1] : null;
}

function fixtureKey(owner, repo, number) {
  return `${owner}/${repo}/${number}`;
}

function getFixture(owner, repo, number) {
  return FIXTURES[fixtureKey(owner, repo, number)] ?? null;
}

function restPull(owner, repo, number, fx) {
  const full = `${owner}/${repo}`;
  const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  return {
    id: Number(number) * 1000,
    node_id: `PR_kwstub_${owner}_${repo}_${number}`,
    number: Number(number),
    title: fx.title,
    body: fx.body,
    state: 'open',
    locked: false,
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    auto_merge: null,
    commits: 1,
    changed_files: 2,
    additions: 10,
    deletions: 2,
    user: restUser('alice'),
    head: {
      ref: 'feature/stub',
      sha,
      repo: {
        id: 1,
        node_id: 'R_head',
        name: repo,
        full_name: full,
        private: false,
        owner: restUser(owner),
      },
    },
    base: {
      ref: 'main',
      sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      repo: {
        id: 1,
        node_id: 'R_base',
        name: repo,
        full_name: full,
        private: false,
        owner: restUser(owner),
      },
    },
    html_url: `https://github.com/${full}/pull/${number}`,
    created_at: T0,
    updated_at: T0,
  };
}

function restRepo(owner, repo) {
  return {
    id: 1,
    node_id: 'R_stub',
    name: repo,
    full_name: `${owner}/${repo}`,
    private: false,
    owner: restUser(owner),
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
    allow_update_branch: true,
    permissions: { admin: true, push: true, pull: true },
    default_branch: 'main',
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    // Intentionally omit Link headers so octokit.paginate does not follow out.
  });
  res.end(payload);
}

function handleGraphql(body, res) {
  let parsed;
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    logLine({ method: 'POST', path: '/graphql', error: 'invalid_json' });
    return json(res, 400, { message: 'invalid json' });
  }
  const op = parseOpName(parsed.query);
  const variables = parsed.variables ?? {};
  logLine({
    method: 'POST',
    path: '/graphql',
    operationName: op,
    variables,
    queryPreview: typeof parsed.query === 'string' ? parsed.query.slice(0, 400) : null,
    // Full query text for D1 evidence when it is PrReviewThreads
    query: op === 'PrReviewThreads' || op === 'PrReviewDecision' ? parsed.query : undefined,
  });

  if (op === 'PrReviewDecision') {
    return json(res, 200, {
      data: {
        repository: {
          pullRequest: { reviewDecision: null },
        },
        viewer: { login: 'kilo-stub-user' },
      },
    });
  }

  // Overview enrichment query name may differ — serve reviewDecision + viewer for any
  // query that looks like the overview fragment.
  if (op && /Decision|Overview|Fragment|PullRequest/i.test(op) && op !== 'PrReviewThreads') {
    // Prefer matching known names; still return a safe shape.
    if (op !== 'PrReviewThreadComments') {
      return json(res, 200, {
        data: {
          repository: {
            pullRequest: { reviewDecision: null },
          },
          viewer: { login: 'kilo-stub-user' },
        },
      });
    }
  }

  if (op === 'PrReviewThreads') {
    const owner = variables.owner;
    const name = variables.name;
    const number = variables.number;
    const fx = getFixture(owner, name, number);
    if (!fx) {
      return json(res, 200, {
        data: { repository: { pullRequest: null } },
      });
    }
    return json(res, 200, {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: fx.threads,
            },
          },
        },
      },
    });
  }

  if (op === 'PrReviewThreadComments') {
    return json(res, 200, {
      data: {
        node: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    });
  }

  if (op === 'PrReviewConversationComments') {
    const owner = variables.owner;
    const name = variables.name;
    const number = variables.number;
    const fx = getFixture(owner, name, number);
    if (!fx) {
      return json(res, 200, {
        data: { repository: { pullRequest: null } },
      });
    }
    // Fixtures have ≤3 comments; always one page. first/after slicing is not honored.
    return json(res, 200, {
      data: {
        repository: {
          pullRequest: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: fx.conversationComments,
            },
          },
        },
      },
    });
  }

  // Unknown GraphQL — non-401 so retry path does not rotate tokens.
  return json(res, 200, {
    data: null,
    errors: [{ message: `stub: unhandled GraphQL operation ${op ?? 'unknown'}` }],
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1`);
  const method = req.method || 'GET';
  const pathname = url.pathname;

  try {
    if (method === 'POST' && (pathname === '/graphql' || pathname === '/api/graphql')) {
      const body = await readBody(req);
      return handleGraphql(body, res);
    }

    // GET /repos/{owner}/{repo}/pulls/{number}/files
    let m = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/);
    if (method === 'GET' && m) {
      const [, owner, repo, number] = m;
      const perPage = Math.max(1, Number(url.searchParams.get('per_page')) || 30);
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      logLine({ method, path: pathname, owner, repo, number, page, per_page: perPage });
      const fx = getFixture(owner, repo, number);
      if (!fx) return json(res, 404, { message: 'Not Found' });
      return json(res, 200, fx.files.slice((page - 1) * perPage, page * perPage));
    }

    // GET /repos/{owner}/{repo}/pulls/{number}
    m = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (method === 'GET' && m) {
      const [, owner, repo, number] = m;
      logLine({ method, path: pathname, owner, repo, number });
      const fx = getFixture(owner, repo, number);
      if (!fx) return json(res, 404, { message: 'Not Found' });
      return json(res, 200, restPull(owner, repo, number, fx));
    }

    // GET /repos/{owner}/{repo}/commits/{ref}/check-runs
    m = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/check-runs$/);
    if (method === 'GET' && m) {
      logLine({ method, path: pathname });
      return json(res, 200, { total_count: 0, check_runs: [] });
    }

    // GET /repos/{owner}/{repo}/commits/{ref}/statuses
    m = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/statuses$/);
    if (method === 'GET' && m) {
      logLine({ method, path: pathname });
      return json(res, 200, []);
    }

    // GET /repos/{owner}/{repo}
    m = pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && m) {
      const [, owner, repo] = m;
      logLine({ method, path: pathname, owner, repo });
      return json(res, 200, restRepo(owner, repo));
    }

    // GET /user (sometimes used)
    if (method === 'GET' && pathname === '/user') {
      logLine({ method, path: pathname });
      return json(res, 200, restUser('kilo-stub-user'));
    }

    logLine({ method, path: pathname, unhandled: true });
    return json(res, 404, { message: `stub: unhandled ${method} ${pathname}` });
  } catch (err) {
    logLine({ method, path: pathname, error: String(err) });
    // Never 401
    return json(res, 500, { message: 'stub internal error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(
    JSON.stringify({
      event: 'listen',
      port,
      logPath: LOG_PATH,
      fixtures: Object.keys(FIXTURES),
    })
  );
});
