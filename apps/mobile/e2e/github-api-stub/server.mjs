#!/usr/bin/env node
/**
 * Hermetic local GitHub API stub for mobile PR-review E2E.
 * Node built-ins only. Logs every request; GraphQL logs operation name + variables.
 *
 * Identities:
 *   kilo-stub/discussion-mixed/1               — iOS verifier (id suffix p1)
 *   kilo-stub/discussion-mixed/11              — Android verifier (id suffix p11)
 *   kilo-stub/discussion-conversation-only#2   — conversation comments only (0 review threads)
 *   kilo-stub/discussion-empty#3               — empty discussion
 *   kilo-stub/files-many#4                     — 120 files (3 pages), file-010 multi-hunk, file-060 null patch
 *   kilo-stub/files-dupe#5                     — 51 entries / 50 unique paths, page-two dupe of file-049
 *
 * discussion-mixed timeline (T+minutes from T0):
 *   T+1 threadA c1, T+2 conv1 (dave), T+3 conv2, T+4 threadB c1,
 *   T+5 threadA c2 (reply), T+6 conv3, T+7 outdated, T+8 file-level, T+9 resolved
 *
 * Id-suffix scheme (D9): every thread/comment/node id ends in `_p{suffix}` so parallel
 * platform verifiers never share mutable ids. Numeric databaseIds are offset per key
 * (e.g. 1001 → 11001 for /11). Mutations carry only threadId/subjectId — the stub
 * resolves targets by scanning ALL fixtures for the unique id.
 *
 * Mutation support (stateful, process-lifetime in-place on per-key fixture objects):
 *   ResolveThread / UnresolveThread  — { input: { threadId } }
 *   AddReaction / RemoveReaction     — { input: { subjectId, content } }
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
// T+1 threadA c1, T+2 conv1, T+3 conv2, T+4 threadB c1, T+5 threadA c2, T+6 conv3,
// T+7 outdated, T+8 file-level, T+9 resolved
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

const REACTION_CONTENTS = [
  'THUMBS_UP',
  'THUMBS_DOWN',
  'LAUGH',
  'HOORAY',
  'CONFUSED',
  'HEART',
  'ROCKET',
  'EYES',
];

/**
 * Full 8-group array. Optional overrides patch named contents only;
 * count is written to the nested reactors.totalCount path.
 * @param {Record<string, { count?: number, viewerHasReacted?: boolean }>} [overrides]
 */
const reactionGroups = (overrides = {}) =>
  REACTION_CONTENTS.map(content => {
    const o = overrides[content] ?? {};
    return {
      content,
      viewerHasReacted: o.viewerHasReacted ?? false,
      reactors: { totalCount: o.count ?? 0 },
    };
  });

/** GraphQL IssueComment node for pullRequest.comments (PrReviewConversationComments). */
const conversationComment = (databaseId, login, body, minutes, idSuffix, reactionOverrides) => ({
  id: `IC_stub_${databaseId}_p${idSuffix}`,
  databaseId,
  author: author(login),
  body,
  createdAt: ts(minutes),
  reactionGroups: reactionGroups(reactionOverrides),
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

const DIFF_HUNK_ALPHA =
  '@@ -8,4 +8,9 @@ export function alpha() {\n-  return 1;\n+  // stub change\n+  return 2;\n+}\n+\n+export function alphaExtra() {\n+  return 3;\n }';
const DIFF_HUNK_BETA =
  '@@ -18,3 +18,6 @@ export function beta() {\n-  return 1;\n+  return 2;\n+}\n+\n+export function betaExtra() {\n+  return 3;\n }';
const DIFF_HUNK_ALPHA_OUTDATED =
  '@@ -7,5 +7,5 @@ export function alpha() {\n   const x = 0;\n-  return 1;\n+  return 1;\n   // end\n }';

/**
 * Full-shape fixture helper. Every fixture needs title, body, files, threads,
 * and conversationComments so the GraphQL handlers do not fail.
 */
const filesFixture = (title, files) => ({
  title,
  body: `PR body for ${title}.`,
  files,
  threads: [],
  conversationComments: [],
});

const pad3 = n => String(n).padStart(3, '0');

/** One-hunk patch body for generated files, reusing Alpha shapes. */
const genPatch = n =>
  `@@ -${10 + n * 13},3 +${10 + n * 13},5 @@ export function fn${pad3(n)}() {\n-  return ${n};\n+  // stub change\n+  return ${n + 100};\n+}\n+\n+export function extra${pad3(n)}() {\n+  return ${n + 200};\n }`;

/** Three-hunk patch for file-010.ts (~15 lines per hunk), reusing Alpha/Beta shapes. */
const MULTI_HUNK_PATCH =
  '@@ -12,6 +12,11 @@ export function init() {\n-  return default;\n+  // first hunk alpha\n+  return configured;\n+}\n' +
  '+\n+export function initExtra() {\n+  return 3;\n }\n' +
  '@@ -24,5 +24,10 @@ export function middleware() {\n-  return next;\n+  // second hunk beta\n+  return wrapped;\n+}\n' +
  '+\n+export function middlewareExtra() {\n+  return 3;\n }\n' +
  '@@ -38,5 +38,11 @@ export function teardown() {\n-  return done;\n+  // third hunk combined\n+  return cleaned;\n+}\n' +
  '+\n+export function teardownExtra() {\n+  return 3;\n }';

/**
 * Generate `n` file entries with sorted stable paths `src/gen/file-000.ts` …
 * `src/gen/file-{n-1}.ts`. File 010 gets a multi-hunk patch; file 060 gets
 * `patch: null`; every other file gets a small one-hunk patch.
 */
const manyFiles = n => {
  const files = [];
  for (let i = 0; i < n; i++) {
    const filename = `src/gen/file-${pad3(i)}.ts`;
    if (i === 60) {
      files.push(prFile(filename, 0, 0, null));
    } else if (i === 10) {
      files.push(prFile(filename, 18, 3, MULTI_HUNK_PATCH));
    } else {
      files.push(prFile(filename, 6, 1, genPatch(i)));
    }
  }
  return files;
};

/**
 * 51 entries, 50 unique paths. The 51st entry (index 50, first of page 2)
 * repeats the path of the 50th entry (index 49, last of page 1):
 * `src/gen/file-049.ts`. The overview reports 51 changed files; the Files-list
 * header reports 50 listed — that gap is the dedupe working.
 */
const dupeFiles = () => {
  const files = [];
  for (let i = 0; i <= 49; i++) {
    files.push(prFile(`src/gen/file-${pad3(i)}.ts`, 6, 1, genPatch(i)));
  }
  // Page-two first entry duplicates page-one last entry's path.
  files.push(prFile('src/gen/file-049.ts', 6, 1, genPatch(49)));
  return files;
};

/**
 * Fresh mixed-discussion fixture per call (D9). idSuffix is the platform key
 * fragment (1 = iOS, 11 = Android). databaseIds offset so nothing keys on dupes.
 * @param {string|number} idSuffix
 */
function buildMixedFixture(idSuffix) {
  const s = String(idSuffix);
  const dbOff = (Number(idSuffix) - 1) * 1000;
  const db = n => n + dbOff;
  const tid = name => `PRRT_${name}_p${s}`;
  const cid = name => `PRRC_${name}_p${s}`;

  return {
    title: 'Mixed discussion fixture',
    body: 'PR body for mixed fixture.',
    files: stubFiles(),
    threads: [
      {
        id: tid('thread_a'),
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
              databaseId: db(1001),
              id: cid('a1'),
              body: 'Thread A comment at T+1 (inline review)',
              createdAt: ts(1),
              author: author('alice'),
              diffHunk: DIFF_HUNK_ALPHA,
              reactionGroups: reactionGroups({
                THUMBS_UP: { count: 2, viewerHasReacted: false },
                HEART: { count: 1, viewerHasReacted: true },
              }),
            },
            {
              databaseId: db(1005),
              id: cid('a2'),
              body: 'Thread A reply at T+5 (inline review)',
              createdAt: ts(5),
              author: author('bob'),
              reactionGroups: reactionGroups(),
            },
          ],
        },
      },
      {
        id: tid('thread_b'),
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
              databaseId: db(1004),
              id: cid('b1'),
              body: 'Thread B comment at T+4 (inline review)',
              createdAt: ts(4),
              author: author('carol'),
              diffHunk: DIFF_HUNK_BETA,
              reactionGroups: reactionGroups(),
            },
          ],
        },
      },
      {
        id: tid('thread_outdated'),
        isResolved: false,
        isOutdated: true,
        subjectType: 'LINE',
        path: 'src/alpha.ts',
        line: null,
        startLine: null,
        originalLine: 9,
        originalStartLine: null,
        diffSide: 'LEFT',
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              databaseId: db(1007),
              id: cid('outdated1'),
              body: 'Outdated thread comment at T+7',
              createdAt: ts(7),
              author: author('alice'),
              diffHunk: DIFF_HUNK_ALPHA_OUTDATED,
              reactionGroups: reactionGroups(),
            },
          ],
        },
      },
      {
        id: tid('thread_file'),
        isResolved: false,
        isOutdated: false,
        subjectType: 'FILE',
        path: 'src/alpha.ts',
        line: null,
        startLine: null,
        originalLine: null,
        originalStartLine: null,
        diffSide: null,
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              databaseId: db(1008),
              id: cid('file1'),
              body: 'File-level comment at T+8',
              createdAt: ts(8),
              author: author('bob'),
              reactionGroups: reactionGroups(),
            },
          ],
        },
      },
      {
        id: tid('thread_resolved'),
        isResolved: true,
        isOutdated: false,
        subjectType: 'LINE',
        path: 'src/beta.ts',
        line: 18,
        startLine: 18,
        originalLine: 18,
        originalStartLine: 18,
        diffSide: 'RIGHT',
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              databaseId: db(1009),
              id: cid('resolved1'),
              body: 'Resolved thread comment at T+9',
              createdAt: ts(9),
              author: author('carol'),
              diffHunk: DIFF_HUNK_BETA,
              reactionGroups: reactionGroups(),
            },
          ],
        },
      },
    ],
    // GraphQL pullRequest.comments nodes. REST issues/{n}/comments is intentionally
    // not served — S2 reads conversation comments over GraphQL only.
    conversationComments: [
      conversationComment(db(2002), 'dave', 'Conversation comment at T+2', 2, s, {
        THUMBS_UP: { count: 1, viewerHasReacted: false },
      }),
      conversationComment(db(2003), 'erin', 'Conversation comment at T+3', 3, s),
      conversationComment(db(2006), 'frank', 'Conversation comment at T+6', 6, s),
    ],
  };
}

/** @type {Record<string, object>} */
const FIXTURES = {
  'kilo-stub/discussion-mixed/1': buildMixedFixture(1),
  'kilo-stub/discussion-mixed/11': buildMixedFixture(11),
  'kilo-stub/discussion-conversation-only/2': {
    title: 'Conversation-only fixture',
    body: 'PR body for conversation-only fixture.',
    files: stubFiles(),
    threads: [],
    conversationComments: [
      conversationComment(3001, 'dave', 'Only conversation comment one', 2, '2'),
      conversationComment(3002, 'erin', 'Only conversation comment two', 6, '2'),
    ],
  },
  'kilo-stub/discussion-empty/3': {
    title: 'Empty discussion fixture',
    body: 'PR body for empty fixture.',
    files: stubFiles(),
    threads: [],
    conversationComments: [],
  },
  'kilo-stub/files-many/4': filesFixture('Many files fixture (120)', manyFiles(120)),
  'kilo-stub/files-dupe/5': filesFixture(
    'Duplicate file fixture (51 entries, 50 unique)',
    dupeFiles()
  ),
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

/** Walk all fixtures for a thread id (mutations carry no owner/repo/number). */
function findThreadById(threadId) {
  for (const fx of Object.values(FIXTURES)) {
    const threads = fx.threads ?? [];
    for (const thread of threads) {
      if (thread.id === threadId) return thread;
    }
  }
  return null;
}

/**
 * Walk all fixtures for a comment node id — review-comment nodes and
 * conversation-comment nodes.
 */
function findCommentById(subjectId) {
  for (const fx of Object.values(FIXTURES)) {
    for (const thread of fx.threads ?? []) {
      for (const node of thread.comments?.nodes ?? []) {
        if (node.id === subjectId) return node;
      }
    }
    for (const node of fx.conversationComments ?? []) {
      if (node.id === subjectId) return node;
    }
  }
  return null;
}

function flipReaction(node, content, add) {
  const groups = node.reactionGroups ?? [];
  const group = groups.find(g => g.content === content);
  if (!group) return;
  if (add) {
    group.viewerHasReacted = true;
    group.reactors.totalCount = (group.reactors?.totalCount ?? 0) + 1;
  } else {
    group.viewerHasReacted = false;
    group.reactors.totalCount = Math.max(0, (group.reactors?.totalCount ?? 0) - 1);
  }
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
    changed_files: fx.files.length,
    additions: fx.files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
    deletions: fx.files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
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

  // Stateful mutations — resolve target by scanning all fixtures (ids are unique
  // across platform keys). Mutate fixture objects in place for process lifetime.
  if (op === 'ResolveThread') {
    const threadId = variables.input?.threadId;
    const thread = threadId ? findThreadById(threadId) : null;
    if (!thread) {
      return json(res, 200, { data: { resolveReviewThread: null } });
    }
    thread.isResolved = true;
    return json(res, 200, {
      data: {
        resolveReviewThread: {
          thread: { id: thread.id, isResolved: true },
        },
      },
    });
  }

  if (op === 'UnresolveThread') {
    const threadId = variables.input?.threadId;
    const thread = threadId ? findThreadById(threadId) : null;
    if (!thread) {
      return json(res, 200, { data: { unresolveReviewThread: null } });
    }
    thread.isResolved = false;
    return json(res, 200, {
      data: {
        unresolveReviewThread: {
          thread: { id: thread.id, isResolved: false },
        },
      },
    });
  }

  if (op === 'AddReaction') {
    const subjectId = variables.input?.subjectId;
    const content = variables.input?.content;
    const node = subjectId ? findCommentById(subjectId) : null;
    if (!node || !content) {
      return json(res, 200, { data: { addReaction: null } });
    }
    flipReaction(node, content, true);
    return json(res, 200, {
      data: {
        addReaction: {
          reaction: { content },
        },
      },
    });
  }

  if (op === 'RemoveReaction') {
    const subjectId = variables.input?.subjectId;
    const content = variables.input?.content;
    const node = subjectId ? findCommentById(subjectId) : null;
    if (!node || !content) {
      return json(res, 200, { data: { removeReaction: null } });
    }
    flipReaction(node, content, false);
    return json(res, 200, {
      data: {
        removeReaction: {
          reaction: { content },
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
