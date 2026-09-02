import { describe, expect, it, vi } from 'vitest';
import {
  createGithubClient,
  createGithubTools,
  resolveIncrementalComparison,
  MAX_COMMENT_BODY_LENGTH,
  MAX_CONTEXT_RECORDS,
  MAX_DIFF_FILES,
  MAX_FALLBACK_PATCH_BYTES,
  MAX_FILE_BYTES,
  MAX_GITHUB_PAGES,
  MAX_GITHUB_RESPONSE_BYTES,
  MAX_GITHUB_TRAVERSAL_BYTES,
  MAX_HISTORY_REQUESTS,
  MAX_HISTORY_COMMITS,
  MAX_PUBLICATION_ATTEMPTS,
  MAX_RETRIEVAL_BYTES,
  MAX_RENAME_PROOF_REQUESTS,
  READ_ONLY_GITHUB_TOOL_NAMES,
  type GithubClient,
  type GithubPublicationDetails,
  type GithubPublicationState,
  type GithubPublishedEvent,
  type GithubProposalEvent,
} from '../../src/github';
import { ReviewProposalSchema } from '../../src/types';

const snapshot = {
  headSha: 'a'.repeat(40),
  baseTipSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
};
const input = {
  owner: 'acme',
  repo: 'widget',
  pullNumber: 42,
  gitToken: 'fixture-git-token',
  kiloToken: 'fixture-kilo-token',
  dryRun: false,
};
const repositoryPath = '/repos/acme/widget';
const repositoryId = 123;
const numericRepositoryPath = `/repositories/${repositoryId}`;
const pullPath = '/repos/acme/widget/pulls/42';
const issuePath = '/repos/acme/widget/issues/42';
const comparePath = `/repos/acme/widget/compare/${snapshot.baseTipSha}...${snapshot.headSha}`;
const previousHeadSha = 'e'.repeat(40);
const deltaComparePath = `/repos/acme/widget/compare/${previousHeadSha}...${snapshot.headSha}`;
const incrementalSelection = {
  requestedMode: 'incremental',
  effectiveMode: 'incremental',
  previousRunId: 'previous-candidate',
  previousHeadSha,
  previousSummaryHash: 'f'.repeat(64),
  changedFileCount: 1,
} satisfies NonNullable<Parameters<typeof createGithubTools>[0]['reviewSelection']>;
const kiloBotUser = { login: 'kilo-code[bot]' };
const finding = { path: 'src/index.ts', line: 4, side: 'RIGHT', body: 'Issue' };
const args = { comments: [finding] };
const oldSummary = '<!-- kilo-review -->\nold summary';
const summaryHistory = [
  '<!-- kilo-review-history -->',
  '<details>',
  '<summary><b>Previous Review Summary</b></summary>',
  '',
  '_Current summary above is authoritative. Previous snapshots are kept for context only._',
  '',
  '<!-- kilo-review-history-entry -->',
  '### Previous review',
  '',
  'Archived finding',
  '</details>',
  '<!-- /kilo-review-history -->',
].join('\n');
const summaryUsage =
  '<!-- kilo-usage -->\n<sub>Reviewed by model · Input: 1K · Output: 200 · Cached: 0</sub>';
const summaryGuidance =
  '<!-- kilo-review-guidance -->\n<sub>Review guidance: REVIEW.md from base branch `main`</sub>';
const summaryFooter = `---\n${summaryUsage}\n${summaryGuidance}`;
const runId = 'trusted-candidate-run';
type ToolOptions = Parameters<typeof createGithubTools>[0];
type RecordValue = Record<string, unknown>;

async function executeTool<T = RecordValue>(
  tools: ReturnType<typeof createGithubTools>,
  name: string,
  value: unknown,
  signal?: AbortSignal
): Promise<T> {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`${name} has no execute function`);
  return (await execute(
    value as never,
    {
      toolCallId: 'test-call',
      messages: [],
      context: {},
      abortSignal: signal,
    } as never
  )) as T;
}

function diffFile(overrides: RecordValue = {}): RecordValue {
  return {
    sha: 'd'.repeat(40),
    filename: 'src/index.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: '@@ -1,5 +1,6 @@\n one\n two\n-old\n+new\n+next\n four\n five',
    ...overrides,
  };
}

function inlineComment(overrides: RecordValue = {}): RecordValue {
  return {
    id: 14,
    path: 'src/index.ts',
    line: 4,
    original_line: 4,
    position: 3,
    subject_type: 'line',
    side: 'RIGHT',
    body: 'Already reported',
    user: { login: 'octocat' },
    commit_id: snapshot.headSha,
    original_commit_id: snapshot.headSha,
    in_reply_to_id: null,
    pull_request_url: `https://api.github.com${pullPath}`,
    created_at: '2026-08-27T00:00:00Z',
    updated_at: '2026-08-27T00:00:00Z',
    ...overrides,
  };
}

function issueComment(overrides: RecordValue = {}): RecordValue {
  return {
    id: 9,
    body: 'Discussion',
    issue_url: `https://api.github.com${issuePath}`,
    user: { login: 'octocat' },
    created_at: '2026-08-27T00:00:00Z',
    updated_at: '2026-08-27T00:00:00Z',
    ...overrides,
  };
}

function review(overrides: RecordValue = {}): RecordValue {
  return {
    id: 91,
    body: '',
    user: kiloBotUser,
    state: 'COMMENTED',
    commit_id: snapshot.headSha,
    pull_request_url: `https://api.github.com${pullPath}`,
    submitted_at: '2026-08-27T00:00:00Z',
    ...overrides,
  };
}

function commitRecord(sha = '1'.repeat(40), overrides: RecordValue = {}): RecordValue {
  return {
    sha,
    commit: {
      message: 'Change widget',
      author: { name: 'Fixture author', date: '2026-08-28T00:00:00Z' },
    },
    parents: [{ sha: '2'.repeat(40) }],
    ...overrides,
  };
}

function historyRecords(count: number, start = 1): RecordValue[] {
  return Array.from({ length: count }, (_, index) =>
    commitRecord((start + index).toString(16).padStart(40, '0'))
  );
}

function pageResponse(rows: RecordValue[], url: URL): Response {
  const page = Number(url.searchParams.get('page') ?? 1);
  const pageSize = Number(url.searchParams.get('per_page') ?? 100);
  const next = new URL(url);
  next.pathname = next.pathname.replace(repositoryPath, numericRepositoryPath);
  next.searchParams.set('page', String(page + 1));
  return Response.json(rows.slice((page - 1) * pageSize, page * pageSize), {
    headers: page * pageSize < rows.length ? { Link: `<${next.href}>; rel="next"` } : {},
  });
}

function fakeApi() {
  const api = {
    repository: { id: repositoryId } as RecordValue,
    pull: {
      head: { sha: snapshot.headSha, ref: 'feature' },
      base: { sha: snapshot.baseTipSha, ref: 'main' },
      state: 'open',
      draft: false,
      title: 'Widget',
      body: 'Description',
      user: { login: 'octocat' },
    } as RecordValue,
    files: [diffFile()],
    inline: [] as RecordValue[],
    issues: [] as RecordValue[],
    reviews: [] as RecordValue[],
    reviewComments: new Map<number, RecordValue[]>(),
    contents: new Map<string, RecordValue>(),
    gitCommits: new Map<string, RecordValue>(),
    gitTrees: new Map<string, RecordValue>(),
    history: [commitRecord()],
    commits: new Map<string, RecordValue>([
      [snapshot.headSha, commitRecord(snapshot.headSha, { files: [diffFile()] })],
    ]),
    compareBase: snapshot.baseTipSha as string | undefined,
    compareMergeBase: snapshot.mergeBaseSha as string | undefined,
    compareFiles: undefined as RecordValue[] | undefined,
    deltaFiles: [diffFile()],
    deltaBase: previousHeadSha as string | undefined,
    deltaMergeBase: previousHeadSha as string | undefined,
    deltaStatus: 'ahead' as string | undefined,
    reportedFileCount: undefined as number | undefined,
    override: undefined as
      | ((url: URL, init: RequestInit) => Promise<Response | undefined> | Response | undefined)
      | undefined,
    loseWriteResponse: false,
    requests: [] as Array<{ url: URL; init: RequestInit; body?: unknown }>,
  };
  let nextId = 1_000;
  const fetch = vi.fn(
    async (request: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      const method = init.method ?? 'GET';
      const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      api.requests.push({ url, init, body });
      const overridden = await api.override?.(url, init);
      if (overridden) return overridden;
      if (method === 'GET') {
        if (url.pathname === repositoryPath) return Response.json(api.repository);
        if (url.pathname.startsWith(`${repositoryPath}/git/commits/`)) {
          const commit = api.gitCommits.get(
            url.pathname.slice(`${repositoryPath}/git/commits/`.length)
          );
          return Response.json(commit ?? {}, { status: commit ? 200 : 404 });
        }
        if (url.pathname.startsWith(`${repositoryPath}/git/trees/`)) {
          const tree = api.gitTrees.get(url.pathname.slice(`${repositoryPath}/git/trees/`.length));
          return Response.json(tree ?? {}, { status: tree ? 200 : 404 });
        }
        if (url.pathname === `${repositoryPath}/commits`) return pageResponse(api.history, url);
        if (url.pathname.startsWith(`${repositoryPath}/commits/`)) {
          const sha = url.pathname.slice(`${repositoryPath}/commits/`.length);
          const commit = api.commits.get(sha);
          return Response.json(commit ?? {}, { status: commit ? 200 : 404 });
        }
        if (url.pathname === pullPath)
          return Response.json({
            ...api.pull,
            changed_files: api.reportedFileCount ?? api.files.length,
          });
        if (url.pathname === comparePath)
          return Response.json({
            base_commit: { sha: api.compareBase },
            merge_base_commit: { sha: api.compareMergeBase },
            files: api.compareFiles ?? api.files.slice(0, MAX_DIFF_FILES),
          });
        if (url.pathname === deltaComparePath)
          return Response.json({
            base_commit: { sha: api.deltaBase },
            merge_base_commit: { sha: api.deltaMergeBase },
            status: api.deltaStatus,
            files: api.deltaFiles,
          });
        if (url.pathname === `${pullPath}/files`) return pageResponse(api.files, url);
        if (url.pathname === `${pullPath}/comments`) return pageResponse(api.inline, url);
        if (url.pathname === `${issuePath}/comments`) return pageResponse(api.issues, url);
        if (url.pathname === `${pullPath}/reviews`) return pageResponse(api.reviews, url);
        const reviewComments = /\/pulls\/42\/reviews\/(\d+)\/comments$/.exec(url.pathname);
        if (reviewComments)
          return pageResponse(api.reviewComments.get(Number(reviewComments[1])) ?? [], url);
        const inlineId = /\/pulls\/comments\/(\d+)$/.exec(url.pathname);
        const issueId = /\/issues\/comments\/(\d+)$/.exec(url.pathname);
        const reviewId = /\/pulls\/42\/reviews\/(\d+)$/.exec(url.pathname);
        const record = inlineId
          ? api.inline.find(comment => comment.id === Number(inlineId[1]))
          : issueId
            ? api.issues.find(comment => comment.id === Number(issueId[1]))
            : reviewId
              ? api.reviews.find(comment => comment.id === Number(reviewId[1]))
              : undefined;
        if (inlineId || issueId || reviewId)
          return Response.json(record ?? {}, { status: record ? 200 : 404 });
        if (url.pathname.startsWith('/repos/acme/widget/contents/')) {
          const path = decodeURIComponent(
            url.pathname.slice('/repos/acme/widget/contents/'.length)
          );
          const content = api.contents.get(`${url.searchParams.get('ref')}:${path}`);
          return Response.json(content ?? {}, { status: content ? 200 : 404 });
        }
      }
      const payload = body as { body: string; commit_id?: string; comments?: RecordValue[] };
      let result: RecordValue | undefined;
      if (method === 'POST' && url.pathname === `${pullPath}/reviews`) {
        const id = nextId++;
        result = review({ id, body: payload.body, commit_id: payload.commit_id });
        api.reviews.push(result);
        const comments = (payload.comments ?? []).map(comment =>
          inlineComment({ ...comment, id: nextId++, user: kiloBotUser })
        );
        api.reviewComments.set(id, comments);
        api.inline.push(...comments);
      } else if (method === 'POST' && url.pathname === `${issuePath}/comments`) {
        result = issueComment({ id: nextId++, body: payload.body, user: kiloBotUser });
        api.issues.push(result);
      } else if (method === 'PATCH') {
        const id = Number(url.pathname.split('/').at(-1));
        result = api.issues.find(comment => comment.id === id);
        if (result) result.body = payload.body;
      }
      if (result) {
        if (api.loseWriteResponse) throw new Error('connection interrupted after acceptance');
        return Response.json(result);
      }
      throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
    }
  );
  return { ...api, fetch, data: api };
}

function setup(extra: Partial<ToolOptions> = {}) {
  const { fetch, data: api } = fakeApi();
  const onPublicationStarted = vi.fn(
    async (_kind: 'review' | 'summary', _details?: GithubPublicationDetails) => {}
  );
  const onPublicationRejected = vi.fn(async (_kind: 'review' | 'summary') => {});
  const onPublished = vi.fn(async (_event?: GithubPublishedEvent) => {});
  const onProposal = vi.fn(async (_event: GithubProposalEvent) => {});
  const onContextIncomplete = vi.fn(async (_reason: string) => {});
  const create = (overrides: Partial<ToolOptions> = {}) =>
    createGithubTools({
      input,
      runId,
      ...snapshot,
      fetchImpl: fetch,
      onPublicationStarted,
      onPublicationRejected,
      onPublished,
      onProposal,
      onContextIncomplete,
      ...extra,
      ...overrides,
    });
  return {
    api,
    fetch,
    create,
    tools: create(),
    onPublicationStarted,
    onPublicationRejected,
    onPublished,
    onProposal,
    onContextIncomplete,
  };
}

function writes(api: ReturnType<typeof setup>['api']) {
  return api.requests.filter(request => ['POST', 'PATCH'].includes(request.init.method ?? 'GET'));
}

async function hash(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

async function ownedSetup(body = oldSummary, extra: Partial<ToolOptions> = {}) {
  const proof = { previousRunId: 'previous-candidate', commentId: 9, bodyHash: await hash(body) };
  const fixture = setup({ ...extra, summaryOwnership: proof });
  fixture.api.issues.push(issueComment({ body, user: kiloBotUser }));
  return { ...fixture, proof };
}

function content(path: string, text: string): RecordValue {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    type: 'file',
    path,
    size: bytes.byteLength,
    encoding: 'base64',
    content: btoa(binary),
    sha: 'd'.repeat(40),
  };
}

function gitSnapshot(
  api: ReturnType<typeof setup>['api'],
  commitSha: string,
  files: Array<RecordValue & { path: string }>
) {
  function build(entries: Array<RecordValue & { path: string }>): {
    sha: string;
    truncated: boolean;
    tree: RecordValue[];
  } {
    const tree: RecordValue[] = [];
    const directories = new Map<string, Array<RecordValue & { path: string }>>();
    for (const entry of entries) {
      const slash = entry.path.indexOf('/');
      if (slash < 0) {
        tree.push({ mode: '100644', type: 'blob', sha: 'd'.repeat(40), ...entry });
      } else {
        const directory = entry.path.slice(0, slash);
        const children = directories.get(directory) ?? [];
        children.push({ ...entry, path: entry.path.slice(slash + 1) });
        directories.set(directory, children);
      }
    }
    for (const [path, children] of directories)
      tree.push({ path, mode: '040000', type: 'tree', sha: build(children).sha });
    const result = {
      sha: (api.gitTrees.size + 1).toString(16).padStart(40, '0'),
      truncated: false,
      tree,
    };
    api.gitTrees.set(result.sha, result);
    return result;
  }
  const root = build(files);
  const commit = { sha: commitSha, tree: { sha: root.sha } };
  api.gitCommits.set(commitSha, commit);
  return { root, commit };
}

describe('bounded, abortable GitHub transport', () => {
  it('defaults to api.github.com when apiUrl is omitted', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    await createGithubClient('fixture-token', fetchMock).get('/repos/acme/widget');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.github.com/repos/acme/widget');
  });

  it('uses the provided apiUrl origin', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    await createGithubClient('fixture-token', fetchMock, 'http://127.0.0.1:8877').get(
      '/repos/acme/widget'
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8877/repos/acme/widget');
  });

  it('rejects a direct cross-origin URL before constructing an authenticated request', async () => {
    const fetchMock = vi.fn();
    await expect(
      createGithubClient('fixture-secret', fetchMock).get('https://attacker.example/steal')
    ).rejects.toThrow('origin does not match');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['next', 'last'] as const)(
    'rejects a cross-origin %s pagination link before exposing authorization',
    async relation => {
      const fetchMock = vi.fn(async () =>
        Response.json([{ id: 1 }], {
          headers: { Link: `<https://attacker.example/comments?page=2>; rel="${relation}"` },
        })
      );
      await expect(
        createGithubClient('fixture-secret', fetchMock).paginate(`${pullPath}/comments`, {
          fromEnd: relation === 'last',
        })
      ).rejects.toThrow('origin does not match');
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  );

  it('rejects redirect responses using the supported Workers request mode', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(new Request(url, init).redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example/steal' },
      });
    });
    await expect(
      createGithubClient('fixture-secret', fetchMock).get('/repos/acme/widget')
    ).rejects.toMatchObject({ status: 302 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('follows same-origin pagination links with manual redirect mode and the same abort signal', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      expect(init?.signal).toBe(controller.signal);
      expect(init?.redirect).toBe('manual');
      return url.searchParams.get('page') === '2'
        ? Response.json([{ id: 2 }])
        : Response.json([{ id: 1 }], {
            headers: { Link: `<https://api.github.com${pullPath}/comments?page=2>; rel="next"` },
          });
    });
    await expect(
      createGithubClient('fixture-token', fetchMock).paginate(`${pullPath}/comments`, {
        signal: controller.signal,
      })
    ).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it.each([false, true])(
    'follows verified numeric repository links with fromEnd=%s',
    async fromEnd => {
      const controller = new AbortController();
      const requested: URL[] = [];
      const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(request instanceof Request ? request.url : request.toString());
        requested.push(url);
        expect(init?.signal).toBe(controller.signal);
        if (url.pathname === repositoryPath) return Response.json({ id: repositoryId });
        expect(url.pathname).toBe(`${issuePath}/comments`);
        const page = Number(url.searchParams.get('page') ?? 1);
        const links = [];
        if (page < 3) {
          links.push(
            `<https://api.github.com${numericRepositoryPath}/issues/42/comments?page=${page + 1}>; rel="next"`
          );
          links.push(
            `<https://api.github.com${numericRepositoryPath}/issues/42/comments?page=3>; rel="last"`
          );
        }
        if (page > 1)
          links.push(
            `<https://api.github.com${numericRepositoryPath}/issues/42/comments?page=${page - 1}>; rel="prev"`
          );
        return Response.json([{ id: page }], { headers: { Link: links.join(', ') } });
      });
      const result = await createGithubClient('fixture-token', fetchMock).paginate(
        `${issuePath}/comments`,
        { fromEnd, ...(fromEnd ? { maxItems: 2 } : {}), signal: controller.signal }
      );
      expect(result).toEqual(fromEnd ? [{ id: 3 }, { id: 2 }] : [{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(requested.filter(url => url.pathname === repositoryPath)).toHaveLength(1);
    }
  );

  it('rejects an unverified numeric repository before fetching its pagination endpoint', async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      requested.push(url.pathname);
      if (url.pathname === repositoryPath) return Response.json({ id: repositoryId });
      return Response.json([], {
        headers: {
          Link: '<https://api.github.com/repositories/456/pulls/42/comments?page=2>; rel="next"',
        },
      });
    });
    await expect(
      createGithubClient('fixture-token', fetchMock).paginate(`${pullPath}/comments`)
    ).rejects.toThrow('escaped its endpoint');
    expect(requested).toEqual([`${pullPath}/comments`, repositoryPath]);
  });

  it('treats numeric and named aliases as the same visited pagination endpoint', async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      requested.push(url.pathname);
      if (url.pathname === repositoryPath) return Response.json({ id: repositoryId });
      return Response.json([], {
        headers: {
          Link: `<https://api.github.com${numericRepositoryPath}/pulls/42/comments?page=1>; rel="next"`,
        },
      });
    });
    await expect(
      createGithubClient('fixture-token', fetchMock).paginate(`${pullPath}/comments?page=1`)
    ).rejects.toThrow('repeated');
    expect(requested).toEqual([`${pullPath}/comments`, repositoryPath]);
  });

  it('does not permit pagination to change the same-origin endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([], {
        headers: { Link: '<https://api.github.com/user/emails?page=2>; rel="next"' },
      })
    );
    await expect(
      createGithubClient('fixture-token', fetchMock).paginate(`${pullPath}/comments`)
    ).rejects.toThrow('escaped its endpoint');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps newest items from the last page without unbounded accumulation', async () => {
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      if (url.searchParams.get('page') === '3') return Response.json([{ id: 3 }, { id: 4 }]);
      return Response.json([{ id: 1 }], {
        headers: { Link: `<https://api.github.com${issuePath}/comments?page=3>; rel="last"` },
      });
    });
    await expect(
      createGithubClient('fixture-token', fetchMock).paginate(`${issuePath}/comments`, {
        fromEnd: true,
        maxItems: 2,
      })
    ).resolves.toEqual([{ id: 4 }, { id: 3 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops pagination once maxItems is reached', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([{ id: 1 }], {
        headers: { Link: `<https://api.github.com${pullPath}/comments?page=2>; rel="next"` },
      })
    );
    await expect(
      createGithubClient('fixture-token', fetchMock).paginate(`${pullPath}/comments`, {
        maxItems: 1,
      })
    ).resolves.toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects repeated pagination instead of looping', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json([], {
        headers: { Link: `<https://api.github.com${pullPath}/comments>; rel="next"` },
      })
    );
    await expect(
      createGithubClient('fixture-token', fetchMock).paginate(`${pullPath}/comments`)
    ).rejects.toThrow('repeated');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('bounds pagination even when every page is empty', async () => {
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const next = new URL(request instanceof Request ? request.url : request.toString());
      next.searchParams.set('page', String(Number(next.searchParams.get('page') ?? 1) + 1));
      return Response.json([], { headers: { Link: `<${next.href}>; rel="next"` } });
    });
    await expect(
      createGithubClient('fixture-token', fetchMock).paginate(`${pullPath}/comments`)
    ).rejects.toThrow('50 pages');
    expect(fetchMock).toHaveBeenCalledTimes(MAX_GITHUB_PAGES);
  });

  it('rejects non-array pagination and invalid JSON without leaking response text', async () => {
    const github = createGithubClient(
      'fixture-token',
      vi.fn(async () => new Response('invalid fixture data'))
    );
    await expect(github.get('/repos/acme/widget')).rejects.toThrow('GitHub returned invalid JSON');
    const arrayClient = createGithubClient(
      'fixture-token',
      vi.fn(async () => Response.json({ id: 1 }))
    );
    await expect(arrayClient.paginate(`${pullPath}/comments`)).rejects.toThrow('non-array');
  });

  it('redacts the current token from bounded GitHub error messages', async () => {
    const github = createGithubClient(
      'fixture-secret',
      vi.fn(async () => new Response('fixture-secret', { status: 403 }))
    );
    await expect(github.get('/repos/acme/widget')).rejects.toMatchObject({
      status: 403,
      body: '[redacted]',
    });
  });

  it('rejects an oversized declared body without consuming it', async () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { 'Content-Length': String(MAX_GITHUB_RESPONSE_BYTES + 1) },
    });
    await expect(
      createGithubClient(
        'fixture-token',
        vi.fn(async () => response)
      ).get('/repos/acme/widget')
    ).rejects.toThrow('transport byte budget');
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('counts UTF-8 bytes while streaming and cancels before JSON parsing or accumulation beyond the cap', async () => {
    const cancel = vi.fn();
    const chunk = new TextEncoder().encode('é'.repeat(128 * 1024));
    let reads = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads++;
            controller.enqueue(chunk);
          },
          cancel,
        },
        { highWaterMark: 0 }
      )
    );
    await expect(
      createGithubClient(
        'fixture-token',
        vi.fn(async () => response)
      ).get('/repos/acme/widget')
    ).rejects.toThrow('transport byte budget');
    expect(reads).toBe(MAX_GITHUB_RESPONSE_BYTES / chunk.byteLength + 1);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('decodes split UTF-8 sequences without changing the text', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xc3]));
          controller.enqueue(new Uint8Array([0xa9]));
          controller.close();
        },
      })
    );
    await expect(
      createGithubClient(
        'fixture-token',
        vi.fn(async () => response)
      ).getTextResponse('/repos/acme/widget')
    ).resolves.toMatchObject({ data: 'é', bytes: 2 });
  });

  it('prevents every request when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    const client = createGithubClient('fixture-token', fetchMock);
    await expect(
      client.get('/repos/acme/widget', undefined, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.post('/repos/acme/widget', {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(client.patch('/repos/acme/widget', {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels an in-progress body reader on abort', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            controller.abort();
          },
          cancel,
        },
        { highWaterMark: 0 }
      )
    );
    await expect(
      createGithubClient(
        'fixture-token',
        vi.fn(async () => response)
      ).get('/repos/acme/widget', undefined, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalled();
  });
});

describe('bounded incremental comparison proof', () => {
  it.each([0, 1, 299])(
    'proves an ahead comparison with %s files independently of the PR count',
    async count => {
      const { api, fetch } = setup();
      api.deltaFiles = Array.from({ length: count }, (_, index) =>
        diffFile({ filename: `src/delta-${index}.ts`, patch: undefined })
      );
      api.reportedFileCount = 3_001;
      await expect(
        resolveIncrementalComparison(
          createGithubClient('fixture-token', fetch),
          input,
          snapshot,
          previousHeadSha
        )
      ).resolves.toEqual({ changedFileCount: count });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url.pathname).toBe(deltaComparePath);
      expect(api.requests[0]?.url.search).toBe('?per_page=1');
    }
  );

  it.each([300, 301])(
    'refuses potentially capped %s-file comparisons without PR-files fallback',
    async count => {
      const { api, fetch } = setup();
      api.deltaFiles = Array.from({ length: count }, (_, index) =>
        diffFile({ filename: `${index}.ts` })
      );
      await expect(
        resolveIncrementalComparison(
          createGithubClient('fixture-token', fetch),
          input,
          snapshot,
          previousHeadSha
        )
      ).resolves.toEqual({ fallbackReason: 'comparison_incomplete' });
      expect(api.requests).toHaveLength(1);
    }
  );

  it.each([
    { deltaStatus: 'diverged' },
    { deltaStatus: 'behind' },
    { deltaStatus: 'identical' },
    { deltaBase: snapshot.baseTipSha },
    { deltaMergeBase: snapshot.mergeBaseSha },
  ])('requires the exact previous base, merge base, and ahead status: %j', async changes => {
    const { api, fetch } = setup();
    Object.assign(api, changes);
    await expect(
      resolveIncrementalComparison(
        createGithubClient('fixture-token', fetch),
        input,
        snapshot,
        previousHeadSha
      )
    ).resolves.toEqual({ fallbackReason: 'previous_head_not_ancestor' });
  });

  it('does not admit an unchanged head as an empty incremental review', async () => {
    const { api, fetch } = setup();
    await expect(
      resolveIncrementalComparison(
        createGithubClient('fixture-token', fetch),
        input,
        snapshot,
        snapshot.headSha
      )
    ).resolves.toEqual({ fallbackReason: 'previous_head_not_ancestor' });
    expect(api.requests).toEqual([]);
  });

  it.each([
    [diffFile(), diffFile()],
    [diffFile({ filename: '../escape' })],
    [diffFile({ sha: 'not-a-sha' })],
    [diffFile({ additions: -1 })],
    [diffFile({ changes: 99 })],
    [diffFile({ status: 'renamed' })],
    [diffFile({ status: 'renamed', previous_filename: '../escape' })],
  ])('refuses invalid or duplicated delta metadata', async (...files) => {
    const { api, fetch } = setup();
    api.deltaFiles = files;
    await expect(
      resolveIncrementalComparison(
        createGithubClient('fixture-token', fetch),
        input,
        snapshot,
        previousHeadSha
      )
    ).resolves.toEqual({ fallbackReason: 'comparison_incomplete' });
  });

  it.each([404, 403, 503])('reports an optional compare HTTP %s as unavailable', async status => {
    const { api, fetch } = setup();
    api.override = () => new Response('Unavailable', { status });
    await expect(
      resolveIncrementalComparison(
        createGithubClient('fixture-token', fetch),
        input,
        snapshot,
        previousHeadSha
      )
    ).resolves.toEqual({ fallbackReason: 'comparison_unavailable' });
    expect(api.requests).toHaveLength(1);
  });

  it('bounds response bytes before using comparison evidence', async () => {
    const { api, fetch } = setup();
    api.override = () => new Response('x'.repeat(MAX_GITHUB_RESPONSE_BYTES + 1));
    await expect(
      resolveIncrementalComparison(
        createGithubClient('fixture-token', fetch),
        input,
        snapshot,
        previousHeadSha
      )
    ).resolves.toEqual({ fallbackReason: 'comparison_unavailable' });
  });

  it('propagates cancellation rather than choosing a full-review fallback', async () => {
    const controller = new AbortController();
    const { api, fetch } = setup();
    api.override = (_url, init) => {
      expect(init.signal).toBe(controller.signal);
      controller.abort();
      return new Response('unavailable', { status: 503 });
    };
    await expect(
      resolveIncrementalComparison(
        createGithubClient('fixture-token', fetch),
        input,
        snapshot,
        previousHeadSha,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.requests).toHaveLength(1);
  });
});

describe('selected review scope and current-PR publication anchors', () => {
  it('keeps different file sets and same-file hunks separate', async () => {
    const { tools, api, onContextIncomplete } = setup({ reviewSelection: incrementalSelection });
    const patch = '@@ -20 +20 @@\n-before\n+after';
    api.deltaFiles = [diffFile({ patch, additions: 1, deletions: 1, changes: 2 })];
    api.files.push(diffFile({ filename: 'unrelated.bin', patch: undefined }));
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      comparison: 'review',
      previousHeadSha,
      fileCount: 1,
      patchesComplete: true,
      files: [expect.objectContaining({ patch, oldRevision: 'previous' })],
    });
    expect(await executeTool(tools, 'pr_diff', { comparison: 'current-pr' })).toMatchObject({
      comparison: 'current-pr',
      fileCount: 2,
      patchesComplete: false,
      contextComplete: true,
    });
    expect(await executeTool(tools, 'pr_file_patch', { path: finding.path })).toMatchObject({
      body: patch,
    });
    expect(
      await executeTool(tools, 'pr_file_patch', { path: finding.path, comparison: 'current-pr' })
    ).toMatchObject({ body: diffFile().patch });
    expect(
      await executeTool(tools, 'submit_review', { comments: [{ ...finding, line: 20 }] })
    ).toMatchObject({ error: expect.stringContaining('No current RIGHT-side') });
    expect(await executeTool(tools, 'submit_review', args)).toEqual({ id: 1_000 });
    expect(writes(api)[0]?.body).toMatchObject({
      commit_id: snapshot.headSha,
      body: '',
      comments: [finding],
    });
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it('refuses delta-only files and unavailable attempted current anchors without invalidating delta analysis', async () => {
    const { tools, api, onContextIncomplete } = setup({
      reviewSelection: incrementalSelection,
      input: { ...input, dryRun: true },
    });
    api.deltaFiles = [diffFile({ filename: 'delta-only.ts' })];
    api.files = [diffFile({ patch: undefined })];
    expect(
      await executeTool(tools, 'submit_review', {
        comments: [{ ...finding, path: 'delta-only.ts' }],
      })
    ).toHaveProperty('error');
    expect(await executeTool(tools, 'submit_review', args)).toHaveProperty('error');
    expect(
      await executeTool(tools, 'upsert_summary', { body: 'Delta findings only' })
    ).toMatchObject({ dryRun: true, publishable: true });
    expect(onContextIncomplete).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
  });

  it.each([undefined, '@@ -1,5 +1,6 @@\n+incomplete'])(
    'retains the required-context fence for a missing or partial delta patch',
    async patch => {
      const { tools, api, onContextIncomplete, onProposal } = setup({
        reviewSelection: incrementalSelection,
      });
      api.deltaFiles = [diffFile({ patch })];
      expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
        patchesComplete: false,
        contextComplete: false,
      });
      expect(await executeTool(tools, 'upsert_summary', { body: 'No findings' })).toMatchObject({
        publishable: false,
      });
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(onProposal).not.toHaveBeenCalled();
      expect(writes(api)).toEqual([]);
    }
  );

  it('never changes scope if the selected comparison becomes unavailable during investigation', async () => {
    const { tools, api, onContextIncomplete } = setup({ reviewSelection: incrementalSelection });
    api.override = url =>
      url.pathname === deltaComparePath ? new Response('Unavailable', { status: 503 }) : undefined;
    await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow('Required GitHub context');
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(
      api.requests.some(
        request =>
          request.url.pathname === comparePath || request.url.pathname === `${pullPath}/files`
      )
    ).toBe(false);
  });

  it('refuses a selected count mismatch instead of substituting the full PR', async () => {
    const { tools, api } = setup({
      reviewSelection: { ...incrementalSelection, changedFileCount: 2 },
    });
    await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow('selected file count');
    expect(api.requests.some(request => request.url.pathname === comparePath)).toBe(false);
  });

  it('re-fetches an uncached delta patch only from the exact previous-head comparison', async () => {
    const { tools, api } = setup({ reviewSelection: incrementalSelection });
    const currentPatch = `@@ -0,0 +1 @@\n+${'x'.repeat(6_100)}`;
    const deltaPatch = `@@ -0,0 +1 @@\n+${'y'.repeat(6_100)}`;
    api.files = Array.from({ length: 450 }, (_, index) =>
      diffFile({
        filename: `${index}.ts`,
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: currentPatch,
      })
    );
    api.deltaFiles = [diffFile({ additions: 1, deletions: 0, changes: 1, patch: deltaPatch })];
    await executeTool(tools, 'pr_diff', { comparison: 'current-pr' });
    const delta = await executeTool(tools, 'pr_diff', {});
    expect(delta).toMatchObject({
      fileCount: 1,
      patchesComplete: true,
      contextComplete: true,
      truncated: true,
    });
    expect((delta.files as RecordValue[])[0]?.patch).toBeUndefined();
    expect(await executeTool(tools, 'pr_file_patch', { path: finding.path })).toMatchObject({
      body: deltaPatch,
      comparison: 'review',
      patchComplete: true,
    });
    expect(api.requests.filter(({ url }) => url.pathname === deltaComparePath)).toHaveLength(2);
    expect(api.requests.filter(({ url }) => url.pathname === `${pullPath}/files`)).toHaveLength(5);
  });

  it('does not apply full-PR file-count caps to a proven bounded delta', async () => {
    const { tools, api } = setup({ reviewSelection: incrementalSelection });
    api.reportedFileCount = 3_001;
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      fileCount: 1,
      contextComplete: true,
    });
    expect(
      await executeTool(tools, 'upsert_summary', { body: 'Selected delta complete' })
    ).toHaveProperty('id');
  });

  it('resolves previous and merge-base renames independently and leaves REVIEW.md at base-tip', async () => {
    const { tools, api } = setup({ reviewSelection: incrementalSelection });
    api.deltaFiles = [
      diffFile({ filename: 'new.ts', status: 'renamed', previous_filename: 'previous.ts' }),
    ];
    api.files = [
      diffFile({ filename: 'new.ts', status: 'renamed', previous_filename: 'original.ts' }),
    ];
    api.contents.set(`${previousHeadSha}:previous.ts`, content('previous.ts', 'previous version'));
    api.contents.set(
      `${snapshot.mergeBaseSha}:original.ts`,
      content('original.ts', 'merge-base version')
    );
    api.contents.set(`${snapshot.baseTipSha}:REVIEW.md`, content('REVIEW.md', 'base-tip policy'));
    expect(
      await executeTool(tools, 'pr_file', { path: 'new.ts', revision: 'previous' })
    ).toMatchObject({ sha: previousHeadSha, path: 'previous.ts', body: 'previous version' });
    expect(
      await executeTool(tools, 'pr_file', { path: 'new.ts', revision: 'merge-base' })
    ).toMatchObject({
      sha: snapshot.mergeBaseSha,
      path: 'original.ts',
      body: 'merge-base version',
    });
    expect(
      await executeTool(tools, 'pr_file', { path: 'REVIEW.md', revision: 'base-tip' })
    ).toMatchObject({ sha: snapshot.baseTipSha, body: 'base-tip policy' });
  });

  it('uses range-specific absence metadata for previous and merge-base revisions', async () => {
    const { tools, api } = setup({ reviewSelection: incrementalSelection });
    api.deltaFiles = [diffFile({ status: 'added' })];
    api.contents.set(`${snapshot.mergeBaseSha}:${finding.path}`, content(finding.path, 'old file'));
    expect(
      await executeTool(tools, 'pr_file', { path: finding.path, revision: 'previous' })
    ).toMatchObject({ sha: previousHeadSha, found: false, expectedAbsent: true });
    expect(
      await executeTool(tools, 'pr_file', { path: finding.path, revision: 'merge-base' })
    ).toMatchObject({ sha: snapshot.mergeBaseSha, found: true, body: 'old file' });
  });

  it('does not authorize previous revisions for effective full-review fallbacks', async () => {
    const { tools, api } = setup({
      reviewSelection: {
        requestedMode: 'incremental',
        effectiveMode: 'full',
        previousRunId: 'previous-candidate',
        fallbackReason: 'comparison_incomplete',
      },
    });
    expect(
      await executeTool(tools, 'pr_file', { path: finding.path, revision: 'previous' })
    ).toHaveProperty('error');
    expect(api.requests).toEqual([]);
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      files: [expect.objectContaining({ oldRevision: 'merge-base' })],
    });
  });
});

describe('bounded optional GitHub history', () => {
  it('pins each locally rebuilt history page to the captured head and bounds message previews', async () => {
    const { tools, api } = setup();
    api.history = historyRecords(21);
    api.history[0] = commitRecord('1'.repeat(40), { commit: { message: 'é'.repeat(1_000) } });
    const first = await executeTool(tools, 'pr_history', { path: '/workspace/src/a & b.ts' });
    expect(first).toMatchObject({
      available: true,
      headSha: snapshot.headSha,
      page: 1,
      pageSize: 20,
      pageComplete: true,
      complete: false,
      limited: false,
      nextPage: 2,
    });
    expect(first.commits).toHaveLength(20);
    const preview = (first.commits as RecordValue[])[0];
    expect(preview).toMatchObject({ messageTruncated: true, messageBytes: 2_000 });
    expect(new TextEncoder().encode(preview.message as string).byteLength).toBeLessThanOrEqual(
      MAX_COMMENT_BODY_LENGTH
    );
    const second = await executeTool(tools, 'pr_history', { path: 'src/a & b.ts', page: 2 });
    expect(second).toMatchObject({ page: 2, complete: false, limited: false, nextPage: null });
    expect(second.commits).toHaveLength(1);
    expect(api.requests).toHaveLength(2);
    for (const { url } of api.requests) {
      expect(url.pathname).toBe(`${repositoryPath}/commits`);
      expect(url.searchParams.get('sha')).toBe(snapshot.headSha);
      expect(url.searchParams.get('path')).toBe('src/a & b.ts');
      expect(url.searchParams.get('per_page')).toBe('20');
    }
  });

  it('reports the fifth-page limit without claiming full history or offering a sixth page', async () => {
    const { tools, api } = setup();
    api.history = historyRecords(101);
    expect(await executeTool(tools, 'pr_history', { page: 5 })).toMatchObject({
      page: 5,
      pageComplete: true,
      complete: false,
      limited: true,
      nextPage: null,
      commits: expect.any(Array),
    });
    expect(await executeTool(tools, 'pr_history', { page: 6 })).toHaveProperty('error');
    expect(api.requests).toHaveLength(1);
  });

  it('does not follow arbitrary history Link URLs or let them change the pinned query', async () => {
    const { tools, api } = setup();
    api.override = url =>
      url.pathname === `${repositoryPath}/commits`
        ? Response.json([commitRecord()], {
            headers: { Link: '<https://attacker.example/private?sha=main&page=2>; rel="next"' },
          })
        : undefined;
    expect(await executeTool(tools, 'pr_history', {})).toMatchObject({
      nextPage: 2,
      complete: false,
    });
    await executeTool(tools, 'pr_history', { page: 2 });
    expect(
      api.requests.every(
        ({ url }) =>
          url.origin === 'https://api.github.com' &&
          url.pathname === `${repositoryPath}/commits` &&
          url.searchParams.get('sha') === snapshot.headSha
      )
    ).toBe(true);
  });

  it.each([0, -1, 1.5, 6, Number.NaN, Number.POSITIVE_INFINITY])(
    'enforces history page %s constraints at execution time',
    async page => {
      const { tools, api } = setup();
      expect(await executeTool(tools, 'pr_history', { page })).toHaveProperty('error');
      expect(api.requests).toEqual([]);
    }
  );

  it.each([
    ['pr_history', { path: '../escape' }],
    ['pr_commit', { sha: 'main' }],
    ['pr_commit', { sha: 'https://attacker.example/ref' }],
    ['pr_commit', { sha: snapshot.headSha, path: '../escape' }],
    ['pr_commit', { sha: snapshot.headSha, path: 'src/index.ts', offset: -1 }],
    ['pr_commit', { sha: snapshot.headSha, path: 'src/index.ts', offset: 0.5 }],
    ['pr_commit', { sha: snapshot.headSha, offset: 1 }],
    ['pr_file', { path: 'src/index.ts', revision: 'history' }],
    ['pr_file', { path: 'src/index.ts', revision: 'history', commitSha: 'main' }],
    ['pr_file', { path: 'src/index.ts', revision: 'head', commitSha: snapshot.headSha }],
    [
      'pr_file',
      { path: 'src/index.ts', revision: 'history', commitSha: snapshot.headSha, offset: -1 },
    ],
  ] as const)('rejects unsupported %s inputs before HTTP', async (name, value) => {
    const { tools, api, onContextIncomplete } = setup();
    expect(await executeTool(tools, name, value)).toHaveProperty('error');
    expect(api.requests).toEqual([]);
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it.each([snapshot.headSha, snapshot.baseTipSha, snapshot.mergeBaseSha, previousHeadSha])(
    'allows captured or effective previous commit %s without expanding parent authority',
    async sha => {
      const { tools, api } = setup({ reviewSelection: incrementalSelection });
      api.commits.set(sha, commitRecord(sha, { files: [diffFile()] }));
      expect(
        await executeTool(tools, 'pr_commit', { sha: sha.toUpperCase(), path: finding.path })
      ).toMatchObject({
        available: true,
        sha,
        filesComplete: true,
        complete: true,
        limited: false,
        patch: { body: diffFile().patch, patchComplete: true },
        parents: ['2'.repeat(40)],
      });
      expect(await executeTool(tools, 'pr_commit', { sha: '2'.repeat(40) })).toMatchObject({
        available: false,
        complete: false,
      });
      expect(api.requests).toHaveLength(1);
    }
  );

  it('requires trusted discovery for arbitrary historical commits and does not authorize history parents', async () => {
    const { tools, api } = setup();
    const sha = '1'.repeat(40);
    api.commits.set(sha, commitRecord(sha, { files: [diffFile()] }));
    expect(await executeTool(tools, 'pr_commit', { sha })).toMatchObject({
      available: false,
      complete: false,
    });
    expect(
      await executeTool(tools, 'pr_file', {
        path: finding.path,
        revision: 'history',
        commitSha: sha,
      })
    ).toMatchObject({ available: false, complete: false });
    expect(api.requests).toEqual([]);
    await executeTool(tools, 'pr_history', {});
    expect(await executeTool(tools, 'pr_commit', { sha })).toMatchObject({ sha, available: true });
    expect(await executeTool(tools, 'pr_commit', { sha: '2'.repeat(40) })).toMatchObject({
      available: false,
    });
    expect(api.requests).toHaveLength(2);
  });

  it('reads exact historical paths without using current PR or delta rename/absence metadata', async () => {
    const sha = '1'.repeat(40);
    const { tools, api, onContextIncomplete } = setup({ reviewSelection: incrementalSelection });
    api.files = [diffFile({ status: 'removed', patch: undefined })];
    api.deltaFiles = [diffFile({ status: 'renamed', previous_filename: 'other.ts' })];
    api.contents.set(`${sha}:${finding.path}`, content(finding.path, 'historical file'));
    await executeTool(tools, 'pr_history', {});
    expect(
      await executeTool(tools, 'pr_file', {
        path: finding.path,
        revision: 'history',
        commitSha: sha,
      })
    ).toMatchObject({
      available: true,
      found: true,
      path: finding.path,
      sha,
      body: 'historical file',
      retrieval: {
        tool: 'pr_file',
        path: finding.path,
        revision: 'history',
        commitSha: sha,
        offset: null,
      },
    });
    expect(api.requests.map(({ url }) => url.pathname)).toEqual([
      `${repositoryPath}/commits`,
      `${repositoryPath}/contents/${finding.path}`,
    ]);
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it('does not authorize the previous SHA when effective mode is full', async () => {
    const { tools, api } = setup({
      reviewSelection: {
        requestedMode: 'incremental',
        effectiveMode: 'full',
        previousRunId: 'previous-candidate',
        fallbackReason: 'previous_head_not_ancestor',
      },
    });
    expect(await executeTool(tools, 'pr_commit', { sha: previousHeadSha })).toMatchObject({
      available: false,
    });
    expect(api.requests).toEqual([]);
  });

  it.each([99, 100])(
    'marks the first %s commit files explicitly complete or capped',
    async count => {
      const { tools, api } = setup();
      api.commits.set(
        snapshot.headSha,
        commitRecord(snapshot.headSha, {
          files: Array.from({ length: count }, (_, index) => diffFile({ filename: `${index}.ts` })),
        })
      );
      expect(await executeTool(tools, 'pr_commit', { sha: snapshot.headSha })).toMatchObject({
        available: true,
        returnedFileCount: count,
        fileLimit: 100,
        filesComplete: count < 100,
        complete: count < 100,
        limited: count === 100,
      });
      expect(api.requests[0]?.url.search).toBe('?per_page=100&page=1');
      expect(api.requests).toHaveLength(1);
    }
  );

  it('does not claim absence for a file beyond the first commit page or fetch additional pages', async () => {
    const { tools, api } = setup();
    api.commits.set(
      snapshot.headSha,
      commitRecord(snapshot.headSha, {
        files: Array.from({ length: 100 }, (_, index) => diffFile({ filename: `${index}.ts` })),
      })
    );
    expect(
      await executeTool(tools, 'pr_commit', { sha: snapshot.headSha, path: 'later.ts' })
    ).toMatchObject({
      filesComplete: false,
      complete: false,
      limited: true,
      patch: {
        available: false,
        patchComplete: false,
        error: expect.stringContaining('no patch or absence is proven'),
      },
    });
    expect(api.requests).toHaveLength(1);
  });

  it('bounds metadata-heavy commit output while retaining explicit file-list incompleteness', async () => {
    const { tools, api } = setup();
    api.commits.set(
      snapshot.headSha,
      commitRecord(snapshot.headSha, {
        files: Array.from({ length: 90 }, (_, index) =>
          diffFile({ filename: `${'é'.repeat(2_000)}/${index}.ts` })
        ),
      })
    );
    const result = await executeTool(tools, 'pr_commit', { sha: snapshot.headSha });
    expect(result).toMatchObject({
      available: true,
      filesComplete: false,
      complete: false,
      limited: true,
    });
    expect((result.files as unknown[]).length).toBeLessThan(90);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(
      MAX_FALLBACK_PATCH_BYTES
    );
  });

  it('returns 32 KiB patch chunks without an unbudgeted result cache', async () => {
    const onHistoryRequest = vi.fn(async () => {});
    const { tools, api } = setup({ onHistoryRequest });
    const patch = `@@ -0,0 +1 @@\n+${'é'.repeat(25_000)}`;
    api.commits.set(
      snapshot.headSha,
      commitRecord(snapshot.headSha, {
        files: [diffFile({ patch, additions: 1, deletions: 0, changes: 1 })],
      })
    );
    const first = await executeTool<{ patch: { body: string; nextOffset: number } }>(
      tools,
      'pr_commit',
      { sha: snapshot.headSha, path: finding.path }
    );
    const second = await executeTool<{ patch: { body: string; nextOffset: null } }>(
      tools,
      'pr_commit',
      { sha: snapshot.headSha, path: finding.path, offset: first.patch.nextOffset }
    );
    expect(first.patch.body + second.patch.body).toBe(patch);
    expect(new TextEncoder().encode(first.patch.body).length).toBeLessThanOrEqual(
      MAX_RETRIEVAL_BYTES
    );
    expect(second.patch.nextOffset).toBeNull();
    expect(onHistoryRequest).toHaveBeenCalledTimes(2);
    expect(api.requests).toHaveLength(2);
  });

  it.each([
    { files: [diffFile({ patch: undefined })] },
    { files: [diffFile({ patch: '@@ -1,5 +1,6 @@\n+partial' })] },
  ])(
    'keeps missing optional commit patches separate from required delta completeness',
    async overrides => {
      const { tools, api, onContextIncomplete } = setup({
        reviewSelection: incrementalSelection,
        input: { ...input, dryRun: true },
      });
      api.commits.set(snapshot.headSha, commitRecord(snapshot.headSha, overrides));
      expect(
        await executeTool(tools, 'pr_commit', { sha: snapshot.headSha, path: finding.path })
      ).toMatchObject({ complete: false, patch: { patchComplete: false, available: false } });
      expect(await executeTool(tools, 'upsert_summary', { body: 'Delta complete' })).toMatchObject({
        publishable: true,
      });
      expect(onContextIncomplete).not.toHaveBeenCalled();
    }
  );

  it.each([
    { sha: '3'.repeat(40), files: [diffFile()] },
    { files: [diffFile(), diffFile()] },
    { files: [diffFile({ changes: 99 })] },
    { files: Array.from({ length: 101 }, (_, index) => diffFile({ filename: `${index}.ts` })) },
  ])(
    'reports malformed optional commit data without empty success or required-context failure',
    async overrides => {
      const { tools, api, onContextIncomplete } = setup();
      api.commits.set(snapshot.headSha, commitRecord(snapshot.headSha, overrides));
      const result = await executeTool(tools, 'pr_commit', { sha: snapshot.headSha });
      expect(result).toMatchObject({ available: false, complete: false });
      expect(result).not.toHaveProperty('files');
      expect(onContextIncomplete).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, '\0binary'])(
    'reports unavailable historical file content without poisoning required context',
    async text => {
      const { tools, api, onContextIncomplete } = setup({ input: { ...input, dryRun: true } });
      if (text !== undefined)
        api.contents.set(`${snapshot.headSha}:${finding.path}`, content(finding.path, text));
      expect(
        await executeTool(tools, 'pr_file', {
          path: finding.path,
          revision: 'history',
          commitSha: snapshot.headSha,
        })
      ).toMatchObject({ available: false, complete: false });
      expect(await executeTool(tools, 'upsert_summary', { body: 'Complete review' })).toMatchObject(
        { publishable: true }
      );
      expect(onContextIncomplete).not.toHaveBeenCalled();
    }
  );

  it.each([404, 429, 503])(
    'makes optional history HTTP %s explicitly unavailable, never a complete empty result',
    async status => {
      const { tools, api, onContextIncomplete } = setup();
      api.override = () => new Response('unavailable', { status });
      const result = await executeTool(tools, 'pr_history', {});
      expect(result).toMatchObject({ available: false, complete: false, limited: true });
      expect(result).not.toHaveProperty('commits');
      expect(api.requests).toHaveLength(status === 503 ? 2 : 1);
      expect(onContextIncomplete).not.toHaveBeenCalled();
    }
  );

  it.each([{ payload: {} }, { payload: [commitRecord(), commitRecord()] }])(
    'does not expose malformed or duplicated history records',
    async ({ payload }) => {
      const { tools, api, onContextIncomplete } = setup();
      api.override = () => Response.json(payload);
      expect(await executeTool(tools, 'pr_history', {})).toMatchObject({
        available: false,
        complete: false,
      });
      expect(await executeTool(tools, 'pr_commit', { sha: '1'.repeat(40) })).toMatchObject({
        available: false,
      });
      expect(api.requests).toHaveLength(1);
      expect(onContextIncomplete).not.toHaveBeenCalled();
    }
  );

  it('bounds optional history transport responses and does not expose or authorize their records', async () => {
    const onHistoryCommits = vi.fn(async (_shas: string[]) => {});
    const { tools, api, onContextIncomplete } = setup({ onHistoryCommits });
    api.override = () => new Response('x'.repeat(MAX_GITHUB_RESPONSE_BYTES + 1));
    expect(await executeTool(tools, 'pr_history', {})).toMatchObject({
      available: false,
      complete: false,
      error: expect.stringContaining('transport byte budget'),
    });
    expect(onHistoryCommits).not.toHaveBeenCalled();
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });
});

describe('run-wide history authorization and budgets', () => {
  it('reserves before every physical request, including a transient retry and a historical file fetch', async () => {
    let reservations = 0;
    const onHistoryRequest = vi.fn(async () => {
      reservations++;
    });
    const { tools, api } = setup({ onHistoryRequest });
    let failed = false;
    api.override = () => {
      expect(reservations).toBe(api.requests.length);
      if (!failed) {
        failed = true;
        return new Response('transient', { status: 503 });
      }
      return undefined;
    };
    await executeTool(tools, 'pr_history', {});
    api.contents.set(`${snapshot.headSha}:${finding.path}`, content(finding.path, 'head history'));
    await executeTool(tools, 'pr_file', {
      path: finding.path,
      revision: 'history',
      commitSha: snapshot.headSha,
    });
    expect(onHistoryRequest).toHaveBeenCalledTimes(3);
    expect(api.requests).toHaveLength(3);
  });

  it('does not retry a failed reservation or expose callback errors as history', async () => {
    const onHistoryRequest = vi.fn(async () => {
      throw new Error('private callback details');
    });
    const { tools, api, onContextIncomplete } = setup({ onHistoryRequest });
    const result = await executeTool(tools, 'pr_history', {});
    expect(result).toMatchObject({ available: false, complete: false });
    expect(JSON.stringify(result)).not.toContain('private callback details');
    expect(onHistoryRequest).toHaveBeenCalledOnce();
    expect(api.requests).toEqual([]);
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it('persists discovered IDs before exposing history and never authorizes rejected discoveries', async () => {
    let release: (() => void) | undefined;
    let rejectPersistence = false;
    const onHistoryCommits = vi.fn(async (_shas: string[]) => {
      if (rejectPersistence) throw new Error('persistence failed');
      await new Promise<void>(resolve => {
        release = resolve;
      });
    });
    const { tools, api } = setup({ onHistoryCommits });
    let exposed = false;
    const result = executeTool(tools, 'pr_history', {}).then(value => {
      exposed = true;
      return value;
    });
    await vi.waitFor(() => expect(onHistoryCommits).toHaveBeenCalledOnce());
    expect(exposed).toBe(false);
    expect(onHistoryCommits).toHaveBeenCalledWith(['1'.repeat(40)]);
    expect(await executeTool(tools, 'pr_commit', { sha: '1'.repeat(40) })).toMatchObject({
      available: false,
    });
    if (!release) throw new Error('history persistence was not pending');
    release();
    expect(await result).toMatchObject({ available: true });
    api.history = [commitRecord('3'.repeat(40))];
    rejectPersistence = true;
    expect(await executeTool(tools, 'pr_history', {})).toMatchObject({
      available: false,
      complete: false,
    });
    expect(await executeTool(tools, 'pr_commit', { sha: '3'.repeat(40) })).toMatchObject({
      available: false,
    });
    expect(api.requests).toHaveLength(2);
  });

  it('keeps one local request budget across all history tools under concurrency', async () => {
    const { tools, api, onContextIncomplete } = setup();
    const results = await Promise.all(
      Array.from({ length: MAX_HISTORY_REQUESTS + 1 }, () => executeTool(tools, 'pr_history', {}))
    );
    expect(results.filter(result => result.available === true)).toHaveLength(MAX_HISTORY_REQUESTS);
    expect(results.filter(result => result.available === false)).toHaveLength(1);
    expect(await executeTool(tools, 'pr_commit', { sha: snapshot.headSha })).toMatchObject({
      available: false,
      error: expect.stringContaining('request budget'),
    });
    expect(
      await executeTool(tools, 'pr_file', {
        path: finding.path,
        revision: 'history',
        commitSha: snapshot.headSha,
      })
    ).toMatchObject({ available: false, error: expect.stringContaining('request budget') });
    expect(api.requests).toHaveLength(MAX_HISTORY_REQUESTS);
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it('performs no unbudgeted snapshot discovery for standalone history requests', async () => {
    const onHistoryRequest = vi.fn(async () => {});
    const { tools, api } = setup({
      baseTipSha: undefined,
      mergeBaseSha: undefined,
      onHistoryRequest,
    });
    expect(await executeTool(tools, 'pr_commit', { sha: '3'.repeat(40) })).toMatchObject({
      available: false,
    });
    expect(api.requests).toEqual([]);
    expect(await executeTool(tools, 'pr_history', {})).toMatchObject({
      available: true,
      headSha: snapshot.headSha,
    });
    expect(await executeTool(tools, 'pr_commit', { sha: snapshot.headSha })).toMatchObject({
      available: true,
    });
    expect(api.requests).toHaveLength(2);
    expect(onHistoryRequest).toHaveBeenCalledTimes(2);
    expect(
      api.requests.every(({ url }) => url.pathname.startsWith(`${repositoryPath}/commits`))
    ).toBe(true);
  });

  it('does not refund a request when discovered-ID persistence fails', async () => {
    const onHistoryCommits = vi.fn(async (_shas: string[]) => {
      throw new Error('not durable');
    });
    const { tools, api } = setup({
      historyState: { requestCount: MAX_HISTORY_REQUESTS - 1, commitShas: [] },
      onHistoryCommits,
    });
    expect(await executeTool(tools, 'pr_history', {})).toMatchObject({ available: false });
    expect(await executeTool(tools, 'pr_history', {})).toMatchObject({
      available: false,
      error: expect.stringContaining('request budget'),
    });
    expect(api.requests).toHaveLength(1);
    expect(onHistoryCommits).toHaveBeenCalledOnce();
  });

  it('does not refund a failed request or permit its retry after the last local reservation', async () => {
    const { tools, api } = setup({
      historyState: { requestCount: MAX_HISTORY_REQUESTS - 1, commitShas: [] },
    });
    api.override = () => new Response('unavailable', { status: 503 });
    expect(await executeTool(tools, 'pr_history', {})).toMatchObject({
      available: false,
      error: expect.stringContaining('request budget'),
    });
    expect(await executeTool(tools, 'pr_history', {})).toMatchObject({
      available: false,
      error: expect.stringContaining('request budget'),
    });
    expect(api.requests).toHaveLength(1);
  });

  it('uses the callback as the sole request counter instead of double-counting a seed', async () => {
    const onHistoryRequest = vi.fn(async () => {});
    const { tools, api } = setup({
      historyState: { requestCount: MAX_HISTORY_REQUESTS, commitShas: [] },
      onHistoryRequest,
    });
    expect(await executeTool(tools, 'pr_history', {})).toMatchObject({ available: true });
    expect(onHistoryRequest).toHaveBeenCalledOnce();
    expect(api.requests).toHaveLength(1);
  });

  it('shares durable reservations across parent, child, and reconstructed tools', async () => {
    const persisted: NonNullable<ToolOptions['historyState']> = {
      requestCount: MAX_HISTORY_REQUESTS - 2,
      commitShas: [],
    };
    const onHistoryRequest = async () => {
      if (persisted.requestCount >= MAX_HISTORY_REQUESTS)
        throw new Error('history budget exhausted');
      persisted.requestCount++;
    };
    const onHistoryCommits = async (shas: string[]) => {
      persisted.commitShas = [...new Set([...persisted.commitShas, ...shas])];
    };
    const { tools, api, create } = setup({
      historyState: structuredClone(persisted),
      onHistoryRequest,
      onHistoryCommits,
    });
    const child = create({ tools: READ_ONLY_GITHUB_TOOL_NAMES });
    const results = await Promise.all([
      executeTool(tools, 'pr_history', {}),
      executeTool(child, 'pr_history', {}),
    ]);
    expect(results.every(result => result.available === true)).toBe(true);
    expect(persisted).toEqual({ requestCount: MAX_HISTORY_REQUESTS, commitShas: ['1'.repeat(40)] });
    const recreated = create({ historyState: structuredClone(persisted) });
    expect(await executeTool(recreated, 'pr_commit', { sha: '1'.repeat(40) })).toMatchObject({
      available: false,
    });
    expect(api.requests).toHaveLength(2);
  });

  it('retains discovered SHA authority across reconstruction without retaining result data', async () => {
    const persisted: NonNullable<ToolOptions['historyState']> = { requestCount: 0, commitShas: [] };
    const { tools, api, create } = setup({
      onHistoryRequest: async () => {
        persisted.requestCount++;
      },
      onHistoryCommits: async shas => {
        persisted.commitShas = [...new Set([...persisted.commitShas, ...shas])];
      },
    });
    const sha = '1'.repeat(40);
    api.commits.set(sha, commitRecord(sha, { files: [diffFile()] }));
    await executeTool(tools, 'pr_history', {});
    const reconstructed = create({ historyState: structuredClone(persisted) });
    expect(await executeTool(reconstructed, 'pr_commit', { sha })).toMatchObject({
      available: true,
      sha,
    });
    expect(persisted.requestCount).toBe(2);
    expect(persisted.commitShas).toEqual([sha]);
    expect(api.requests).toHaveLength(2);
  });

  it('bounds the local discovered-SHA set atomically across concurrent pages', async () => {
    const seed = historyRecords(MAX_HISTORY_COMMITS - 1).map(record => record.sha as string);
    const { tools, api } = setup({ historyState: { requestCount: 0, commitShas: seed } });
    api.override = url =>
      url.pathname === `${repositoryPath}/commits`
        ? Response.json([
            commitRecord(url.searchParams.get('path') === 'a.ts' ? '3'.repeat(40) : '4'.repeat(40)),
          ])
        : undefined;
    const results = await Promise.all([
      executeTool(tools, 'pr_history', { path: 'a.ts' }),
      executeTool(tools, 'pr_history', { path: 'b.ts' }),
    ]);
    expect(results.filter(result => result.available === true)).toHaveLength(1);
    expect(results.filter(result => result.available === false)).toHaveLength(1);
    expect(api.requests).toHaveLength(2);
  });

  it('enforces a shared discovered-commit cap before exposing parent/child history records', async () => {
    const persisted: NonNullable<ToolOptions['historyState']> = {
      requestCount: 0,
      commitShas: historyRecords(99).map(record => record.sha as string),
    };
    const onHistoryCommits = async (shas: string[]) => {
      const next = [...new Set([...persisted.commitShas, ...shas])];
      if (next.length > MAX_HISTORY_COMMITS) throw new Error('commit budget exhausted');
      persisted.commitShas = next;
    };
    const { tools, api, create } = setup({
      historyState: structuredClone(persisted),
      onHistoryRequest: async () => {
        persisted.requestCount++;
      },
      onHistoryCommits,
    });
    api.override = url =>
      url.pathname === `${repositoryPath}/commits`
        ? Response.json([
            commitRecord(url.searchParams.get('path') === 'a.ts' ? '3'.repeat(40) : '4'.repeat(40)),
          ])
        : undefined;
    const child = create({ tools: READ_ONLY_GITHUB_TOOL_NAMES });
    const results = await Promise.all([
      executeTool(tools, 'pr_history', { path: 'a.ts' }),
      executeTool(child, 'pr_history', { path: 'b.ts' }),
    ]);
    expect(results.filter(result => result.available === true)).toHaveLength(1);
    const failed = results.find(result => result.available === false);
    expect(failed).not.toHaveProperty('commits');
    expect(persisted.commitShas).toHaveLength(MAX_HISTORY_COMMITS);
    expect(persisted.requestCount).toBe(2);
  });

  it.each(['request', 'commits'] as const)(
    'propagates abort during the %s callback without exposure or further HTTP',
    async phase => {
      const controller = new AbortController();
      const onHistoryRequest = vi.fn(async () => {
        if (phase === 'request') controller.abort();
      });
      const onHistoryCommits = vi.fn(async (_shas: string[]) => {
        if (phase === 'commits') controller.abort();
      });
      const { tools, api, onContextIncomplete } = setup({ onHistoryRequest, onHistoryCommits });
      await expect(executeTool(tools, 'pr_history', {}, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(onHistoryRequest).toHaveBeenCalledOnce();
      expect(api.requests).toHaveLength(phase === 'request' ? 0 : 1);
      expect(onHistoryCommits).toHaveBeenCalledTimes(phase === 'request' ? 0 : 1);
      expect(onContextIncomplete).not.toHaveBeenCalled();
    }
  );

  it('checks cancellation before reservation and after HTTP without retrying or remembering IDs', async () => {
    const controller = new AbortController();
    const onHistoryRequest = vi.fn(async () => {});
    const onHistoryCommits = vi.fn(async (_shas: string[]) => {});
    const { tools, api, onContextIncomplete } = setup({ onHistoryRequest, onHistoryCommits });
    api.override = () => {
      controller.abort();
      return Response.json([commitRecord()]);
    };
    await expect(executeTool(tools, 'pr_history', {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      executeTool(tools, 'pr_commit', { sha: snapshot.headSha }, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(onHistoryRequest).toHaveBeenCalledOnce();
    expect(api.requests).toHaveLength(1);
    expect(onHistoryCommits).not.toHaveBeenCalled();
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });
});

describe('immutable and recoverable GitHub context', () => {
  it('can expose only the scoped read-only tools', () => {
    const { tools } = setup({ tools: READ_ONLY_GITHUB_TOOL_NAMES });
    expect(new Set(Object.keys(tools))).toEqual(new Set(READ_ONLY_GITHUB_TOOL_NAMES));
    expect(tools).not.toHaveProperty('submit_review');
    expect(tools).not.toHaveProperty('upsert_summary');
  });

  it('uses the runtime-minted token instead of the request fixture token', async () => {
    const { tools, api } = setup({ token: 'fixture-minted-token' });
    await executeTool(tools, 'pr_view', {});
    expect(new Headers(api.requests[0]?.init.headers).get('Authorization')).toBe(
      'Bearer fixture-minted-token'
    );
  });

  it('uses the exact base-tip...head comparison and retains the distinct merge base', async () => {
    const { tools, api } = setup();
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      snapshot,
      source: 'exact-compare',
      fileCount: 1,
      filesComplete: true,
      truncated: false,
    });
    expect(api.requests.some(request => request.url.pathname === comparePath)).toBe(true);
    expect(api.requests.some(request => request.url.pathname === `${pullPath}/files`)).toBe(false);
    expect(api.requests.some(request => request.url.pathname === repositoryPath)).toBe(false);
    expect(
      api.requests.some(
        request => new Headers(request.init.headers).get('Accept') === 'application/vnd.github.diff'
      )
    ).toBe(false);
  });

  it('resolves a complete snapshot for API-compatible callers omitting the new optional SHAs', async () => {
    const { tools } = setup({ baseTipSha: undefined, mergeBaseSha: undefined });
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({ snapshot, fileCount: 1 });
  });

  it.each(['head', 'base'] as const)(
    'rejects a stale %s in read tools and dry-run proposals',
    async field => {
      for (const [name, value] of [
        ['pr_diff', {}],
        ['pr_comments', {}],
        ['submit_review', args],
        ['upsert_summary', { body: 'Summary' }],
      ] as const) {
        const { tools, api, onContextIncomplete, onProposal } = setup({
          input: { ...input, dryRun: true },
        });
        api.pull[field] = { sha: 'e'.repeat(40) };
        await expect(executeTool(tools, name, value)).rejects.toThrow('changed');
        expect(onContextIncomplete).toHaveBeenCalledOnce();
        expect(onProposal).not.toHaveBeenCalled();
        expect(writes(api)).toEqual([]);
      }
    }
  );

  it.each([undefined, 'e'.repeat(40)])(
    'rejects a missing or mismatched immutable merge base',
    async mergeBase => {
      const { tools, api, onContextIncomplete } = setup();
      api.compareMergeBase = mergeBase;
      await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow();
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(writes(api)).toEqual([]);
    }
  );

  it('fails explicitly rather than treating a malformed file record as an empty diff', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.files = [{ filename: 'src/index.ts' }];
    await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow(
      'invalid required response fields'
    );
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(await executeTool(tools, 'upsert_summary', { body: 'No issues' })).toMatchObject({
      publishable: false,
    });
    expect(writes(api)).toEqual([]);
  });

  it.each([300, 320, 450])(
    'completes Compare-capped %s-file lists with guarded PR-file pagination',
    async fileCount => {
      const { tools, api } = setup();
      api.files = Array.from({ length: fileCount }, (_, index) =>
        diffFile({ filename: `src/file-${index}.ts` })
      );
      const result = await executeTool(tools, 'pr_diff', {});
      expect(result).toMatchObject({ fileCount, filesComplete: true, source: 'guarded-pr-files' });
      expect(
        api.requests
          .filter(request => request.url.pathname === `${pullPath}/files`)
          .map(request => request.url.searchParams.get('page'))
      ).toEqual(
        Array.from({ length: Math.ceil(fileCount / 100) }, (_, index) => String(index + 1))
      );
      const lastPageRead = api.requests.findLastIndex(
        request => request.url.pathname === `${pullPath}/files`
      );
      expect(
        api.requests.slice(lastPageRead + 1).some(request => request.url.pathname === pullPath)
      ).toBe(true);
      expect(
        await executeTool(tools, 'pr_file_patch', { path: `src/file-${fileCount - 1}.ts` })
      ).toMatchObject({ body: api.files.at(-1)?.patch, bodyTruncated: false });
    }
  );

  it('completes numeric-alias diff continuations and keeps dry-run publication eligible', async () => {
    const { tools, api, onContextIncomplete } = setup({ input: { ...input, dryRun: true } });
    api.files = Array.from({ length: 320 }, (_, index) =>
      diffFile({ filename: `src/file-${index}.ts` })
    );
    const filenames: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await executeTool<{
        files: Array<{ filename: string }>;
        nextCursor: number | null;
        contextComplete: boolean;
      }>(tools, 'pr_diff', { cursor });
      expect(page.contextComplete).toBe(true);
      filenames.push(...page.files.map(file => file.filename));
      cursor = page.nextCursor;
    }
    expect(filenames).toEqual(api.files.map(file => file.filename));
    expect(
      await executeTool(tools, 'submit_review', {
        comments: [{ ...finding, path: 'src/file-319.ts' }],
      })
    ).toMatchObject({ dryRun: true, publishable: true });
    expect(await executeTool(tools, 'upsert_summary', { body: 'Review complete' })).toMatchObject({
      dryRun: true,
      publishable: true,
    });
    expect(api.requests.filter(request => request.url.pathname === repositoryPath)).toHaveLength(1);
    expect(onContextIncomplete).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
  });

  it('still accepts named pagination without resolving numeric repository identity', async () => {
    const { tools, api } = setup();
    api.files = Array.from({ length: 301 }, (_, index) =>
      diffFile({ filename: `src/file-${index}.ts` })
    );
    api.override = url => {
      if (url.pathname !== `${pullPath}/files`) return undefined;
      const response = pageResponse(api.files, url);
      const link = response.headers.get('Link');
      if (link)
        response.headers.set('Link', link.replaceAll(numericRepositoryPath, repositoryPath));
      return response;
    };
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      fileCount: 301,
      contextComplete: true,
    });
    expect(api.requests.some(request => request.url.pathname === repositoryPath)).toBe(false);
  });

  it.each([
    'https://api.github.com/repositories/456/pulls/42/comments?page=2',
    'https://api.github.com/repositories/123/pulls/43/comments?page=2',
    'https://api.github.com/repositories/123/issues/42/comments?page=2',
    'https://api.github.com/repositories/123/pulls/42/reviews?page=2',
    'https://api.github.com/repositories/123/pulls/42/comments/extra?page=2',
    'https://api.github.com/repositories/0123/pulls/42/comments?page=2',
    'https://attacker.example/repositories/123/pulls/42/comments?page=2',
    'https://fixture-user@api.github.com/repositories/123/pulls/42/comments?page=2',
    'https://api.github.com/repositories/123/pulls/42/comments?page=1',
    'https://api.github.com/repositories/123/pulls/42/comments?page=3',
  ])('rejects out-of-scope numeric continuation %s and fences publication', async next => {
    const { tools, api, onContextIncomplete } = setup();
    api.pull.head = { sha: snapshot.headSha, ref: 'fork', repo: { id: 456 } };
    api.override = url =>
      url.pathname === `${pullPath}/comments`
        ? Response.json([inlineComment()], { headers: { Link: `<${next}>; rel="next"` } })
        : undefined;
    await expect(executeTool(tools, 'pr_comments', {})).rejects.toThrow(
      'invalid scoped continuation'
    );
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(await executeTool(tools, 'submit_review', args)).toMatchObject({ publishable: false });
    expect(await executeTool(tools, 'upsert_summary', { body: 'No issues' })).toMatchObject({
      publishable: false,
    });
    expect(api.requests.some(request => request.url.searchParams.get('page') === '2')).toBe(false);
    expect(writes(api)).toEqual([]);
  });

  it.each([undefined, null, '123', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses numeric aliases when authenticated repository identity is invalid: %s',
    async id => {
      const { tools, api, onContextIncomplete } = setup();
      api.repository.id = id;
      api.inline = Array.from({ length: 101 }, (_, index) => inlineComment({ id: index + 1 }));
      await expect(executeTool(tools, 'pr_comments', {})).rejects.toThrow('invalid');
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(await executeTool(tools, 'upsert_summary', { body: 'No issues' })).toMatchObject({
        publishable: false,
      });
      expect(api.requests.some(request => request.url.searchParams.get('page') === '2')).toBe(
        false
      );
      expect(writes(api)).toEqual([]);
    }
  );

  it.each([403, 404])(
    'fails closed when numeric repository identity lookup returns %s',
    async status => {
      const { tools, api, onContextIncomplete } = setup();
      api.inline = Array.from({ length: 101 }, (_, index) => inlineComment({ id: index + 1 }));
      api.override = url =>
        url.pathname === repositoryPath ? Response.json({}, { status }) : undefined;
      await expect(executeTool(tools, 'pr_comments', {})).rejects.toThrow(
        'Required GitHub context'
      );
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(await executeTool(tools, 'submit_review', args)).toMatchObject({ publishable: false });
      expect(writes(api)).toEqual([]);
    }
  );

  it('does not switch repository identity when a later continuation changes numeric IDs', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.files = Array.from({ length: 301 }, (_, index) =>
      diffFile({ filename: `src/file-${index}.ts` })
    );
    api.override = url => {
      if (url.pathname !== `${pullPath}/files` || url.searchParams.get('page') !== '2')
        return undefined;
      const response = pageResponse(api.files, url);
      response.headers.set(
        'Link',
        '<https://api.github.com/repositories/456/pulls/42/files?page=3>; rel="next"'
      );
      return response;
    };
    await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow('invalid scoped continuation');
    expect(api.requests.filter(request => request.url.pathname === repositoryPath)).toHaveLength(1);
    expect(api.requests.some(request => request.url.searchParams.get('page') === '3')).toBe(false);
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(writes(api)).toEqual([]);
  });

  it('honors cancellation during repository identity lookup without marking context incomplete', async () => {
    const controller = new AbortController();
    const { tools, api, onContextIncomplete } = setup();
    api.inline = Array.from({ length: 101 }, (_, index) => inlineComment({ id: index + 1 }));
    api.override = url => {
      if (url.pathname === repositoryPath) controller.abort();
      return undefined;
    };
    await expect(executeTool(tools, 'pr_comments', {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(api.requests.some(request => request.url.searchParams.get('page') === '2')).toBe(false);
    expect(onContextIncomplete).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
  });

  it.each(['cancellation', 'identity conflict'] as const)(
    'isolates concurrent repository identity lookups during %s',
    async scenario => {
      const controller = new AbortController();
      const { tools, api, onContextIncomplete } = setup();
      const firstEntered = Promise.withResolvers<void>();
      const secondEntered = Promise.withResolvers<void>();
      const firstReply = Promise.withResolvers<Response>();
      const secondReply = Promise.withResolvers<Response>();
      let lookups = 0;
      api.inline = Array.from({ length: 101 }, (_, index) => inlineComment({ id: index + 1 }));
      api.issues = Array.from({ length: 101 }, (_, index) => issueComment({ id: index + 1 }));
      api.override = url => {
        if (url.pathname === repositoryPath) {
          if (++lookups === 1) {
            firstEntered.resolve();
            return firstReply.promise;
          }
          secondEntered.resolve();
          return secondReply.promise;
        }
        if (scenario === 'identity conflict' && url.pathname === `${issuePath}/comments`) {
          const response = pageResponse(api.issues, url);
          response.headers.set(
            'Link',
            '<https://api.github.com/repositories/456/issues/42/comments?page=2>; rel="next"'
          );
          return response;
        }
        return undefined;
      };
      const first = Promise.allSettled([
        executeTool(tools, 'pr_comments', { category: 'inline' }, controller.signal),
      ]);
      await firstEntered.promise;
      const second = Promise.allSettled([executeTool(tools, 'pr_comments', { category: 'issue' })]);
      await secondEntered.promise;
      if (scenario === 'cancellation') controller.abort();
      firstReply.resolve(Response.json({ id: scenario === 'cancellation' ? 456 : repositoryId }));
      const firstResult = await first;
      secondReply.resolve(
        Response.json({ id: scenario === 'identity conflict' ? 456 : repositoryId })
      );
      const secondResult = await second;
      if (scenario === 'cancellation') {
        expect(firstResult).toMatchObject([{ status: 'rejected', reason: { name: 'AbortError' } }]);
        expect(secondResult).toMatchObject([{ status: 'fulfilled', value: { nextPage: 2 } }]);
        expect(onContextIncomplete).not.toHaveBeenCalled();
      } else {
        expect(firstResult).toMatchObject([{ status: 'fulfilled', value: { nextPage: 2 } }]);
        expect(secondResult).toMatchObject([
          {
            status: 'rejected',
            reason: { message: 'GitHub repository identity changed during pagination' },
          },
        ]);
        expect(onContextIncomplete).toHaveBeenCalledOnce();
        expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
          publishable: false,
        });
      }
      expect(writes(api)).toEqual([]);
    }
  );

  it.each(['head', 'base'] as const)(
    'rejects a %s advance during a mutable PR-files fallback',
    async field => {
      const { tools, api, onContextIncomplete } = setup({ input: { ...input, dryRun: true } });
      api.files = Array.from({ length: 301 }, (_, index) =>
        diffFile({ filename: `src/file-${index}.ts` })
      );
      api.override = url => {
        if (url.pathname === `${pullPath}/files` && url.searchParams.get('page') === '2')
          api.pull[field] = { sha: 'e'.repeat(40) };
        return undefined;
      };
      await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow('changed');
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(writes(api)).toEqual([]);
    }
  );

  it('marks an oversized comparison as required incomplete context rather than an empty diff', async () => {
    const { tools, api, onContextIncomplete, onProposal } = setup({
      input: { ...input, dryRun: true },
    });
    api.override = url =>
      url.pathname === comparePath
        ? new Response('x'.repeat(MAX_GITHUB_RESPONSE_BYTES + 1))
        : undefined;
    await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow('transport byte budget');
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(await executeTool(tools, 'upsert_summary', { body: 'No issues' })).toMatchObject({
      publishable: false,
    });
    expect(onProposal).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
  });

  it('rejects an incomplete mutable fallback instead of trusting a capped file count', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.files = Array.from({ length: 300 }, (_, index) =>
      diffFile({ filename: `src/file-${index}.ts` })
    );
    api.reportedFileCount = 301;
    await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow('listing is incomplete');
    expect(onContextIncomplete).toHaveBeenCalledOnce();
  });

  it('rejects unsupported PRs above the 3,000-file completeness cap', async () => {
    const { tools, api } = setup();
    api.reportedFileCount = 3_001;
    await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow('3,000');
    expect(api.requests.some(request => request.url.pathname === comparePath)).toBe(false);
  });

  it('exposes missing/binary patches without pretending they are empty changes', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.files = [diffFile({ patch: undefined })];
    const result = await executeTool(tools, 'pr_diff', {});
    expect(result).toMatchObject({
      files: [expect.objectContaining({ patchStatus: 'binary_or_omitted', originalLength: null })],
      truncated: true,
    });
    expect(await executeTool(tools, 'pr_file_patch', { path: 'src/index.ts' })).toMatchObject({
      patchStatus: 'binary_or_omitted',
      retrieval: [
        { tool: 'pr_file', path: 'src/index.ts', revision: 'head', offset: 0 },
        { tool: 'pr_file', path: 'src/index.ts', revision: 'merge-base', offset: 0 },
      ],
    });
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
      publishable: false,
      blockedReason: expect.stringContaining('patch evidence is incomplete or unavailable'),
    });
    expect(writes(api)).toEqual([]);
  });

  it('bounds diff previews and recovers an uncached patch from a non-final numeric-alias page', async () => {
    const { tools, api, onContextIncomplete } = setup();
    const patch = `@@ -0,0 +1 @@\n+${'x'.repeat(6_100)}`;
    api.files = Array.from({ length: 450 }, (_, index) =>
      diffFile({ filename: `src/file-${index}.ts`, additions: 1, deletions: 0, changes: 1, patch })
    );
    const result = await executeTool(tools, 'pr_diff', {});
    expect(result).toMatchObject({
      fileCount: 450,
      filesComplete: true,
      truncated: true,
      nextCursor: expect.any(Number),
    });
    expect(new TextEncoder().encode(JSON.stringify(result.files)).length).toBeLessThanOrEqual(
      MAX_FALLBACK_PATCH_BYTES + 1_000
    );
    expect(await executeTool(tools, 'pr_file_patch', { path: 'src/file-349.ts' })).toMatchObject({
      body: patch,
      bodyTruncated: false,
      originalLength: patch.length,
    });
    expect(onContextIncomplete).not.toHaveBeenCalled();
    expect(
      api.requests.filter(
        request =>
          request.url.pathname === `${pullPath}/files` &&
          request.url.searchParams.get('page') === '4'
      )
    ).toHaveLength(2);
  });

  it('provides cursors for long per-file patch recovery without treating clipping as terminal', async () => {
    const { tools, api, onContextIncomplete } = setup();
    const patch = `@@ -0,0 +1 @@\n+${'é'.repeat(30_000)}END`;
    api.files = [diffFile({ patch, additions: 1, deletions: 0, changes: 1 })];
    const first = await executeTool(tools, 'pr_file_patch', { path: 'src/index.ts' });
    const last = await executeTool(tools, 'pr_file_patch', {
      path: 'src/index.ts',
      offset: first.nextOffset,
    });
    expect((first.body as string) + (last.body as string)).toBe(patch);
    expect(first).toMatchObject({
      bodyTruncated: true,
      originalLength: patch.length,
      originalBytes: new TextEncoder().encode(patch).length,
    });
    expect(new TextEncoder().encode(first.body as string).length).toBeLessThanOrEqual(
      MAX_RETRIEVAL_BYTES
    );
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it('uses previous_filename and merge-base content for the old side of a rename', async () => {
    const { tools, api } = setup();
    api.files = [
      diffFile({ status: 'renamed', filename: 'src/new.ts', previous_filename: 'src/old.ts' }),
    ];
    api.contents.set(`${snapshot.mergeBaseSha}:src/old.ts`, content('src/old.ts', 'old contents'));
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      files: [
        expect.objectContaining({
          previous_filename: 'src/old.ts',
          oldPath: 'src/old.ts',
          oldRevision: 'merge-base',
        }),
      ],
    });
    expect(
      await executeTool(tools, 'pr_file', { path: 'src/new.ts', revision: 'merge-base' })
    ).toMatchObject({ path: 'src/old.ts', sha: snapshot.mergeBaseSha, body: 'old contents' });
    expect(
      api.requests
        .find(request => request.url.pathname.includes('/contents/'))
        ?.url.searchParams.get('ref')
    ).toBe(snapshot.mergeBaseSha);
  });

  it('uses base-tip, not merge-base, for REVIEW.md and exposes expected deleted-file absence at head', async () => {
    const { tools, api } = setup();
    api.files = [diffFile({ status: 'removed' })];
    api.contents.set(`${snapshot.baseTipSha}:REVIEW.md`, content('REVIEW.md', 'base instructions'));
    expect(
      await executeTool(tools, 'pr_file', { path: 'REVIEW.md', revision: 'base-tip' })
    ).toMatchObject({ body: 'base instructions', sha: snapshot.baseTipSha });
    expect(
      await executeTool(tools, 'pr_file', { path: 'src/index.ts', revision: 'head' })
    ).toMatchObject({ found: false, expectedAbsent: true });
  });

  it.each([
    { path: '../secret', revision: 'head' },
    { path: 'src/index.ts', revision: 'main' },
    { path: 'src/index.ts', revision: 'e'.repeat(40) },
  ])('does not accept arbitrary paths or revisions', async value => {
    const { tools, api } = setup();
    expect(await executeTool(tools, 'pr_file', value)).toHaveProperty('error');
    expect(api.requests).toEqual([]);
  });

  it.each([
    { type: 'symlink', target: 'other' },
    { submodule_git_url: 'https://github.com/acme/other.git' },
    { size: MAX_FILE_BYTES + 1 },
    { content: 'not valid base64' },
    { content: btoa('wrong size') },
  ])('makes unsupported or malformed historical content explicit', async overrides => {
    const { tools, api, onContextIncomplete } = setup();
    api.contents.set(`${snapshot.headSha}:src/index.ts`, {
      ...content('src/index.ts', 'file'),
      ...overrides,
    });
    await expect(
      executeTool(tools, 'pr_file', { path: 'src/index.ts', revision: 'head' })
    ).rejects.toThrow();
    expect(onContextIncomplete).toHaveBeenCalledOnce();
  });

  it('fails closed on required absent or binary file contents', async () => {
    const missing = setup();
    await expect(
      executeTool(missing.tools, 'pr_file', { path: 'missing.ts', revision: 'head' })
    ).rejects.toThrow();
    expect(missing.onContextIncomplete).toHaveBeenCalledOnce();
    const binary = setup();
    binary.api.contents.set(
      `${snapshot.headSha}:src/index.ts`,
      content('src/index.ts', '\0binary')
    );
    await expect(
      executeTool(binary.tools, 'pr_file', { path: 'src/index.ts', revision: 'head' })
    ).rejects.toThrow('Binary or non-UTF-8');
    expect(binary.onContextIncomplete).toHaveBeenCalledOnce();
  });

  it('recovers a long PR description through hash-bound cursors', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.pull.body = `${'x'.repeat(50_000)}END`;
    const first = await executeTool(tools, 'pr_view', {});
    const second = await executeTool(tools, 'pr_view', {
      offset: first.nextOffset,
      bodyHash: first.bodyHash,
    });
    expect((first.body as string) + (second.body as string)).toBe(api.pull.body);
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it.each(['inline', 'issue', 'reviews'] as const)(
    'preserves the end of long %s comments with scoped full retrieval',
    async category => {
      const { tools, api, onContextIncomplete } = setup();
      const body = `${'é'.repeat(40_000)}\nconclusion and suggestion`;
      if (category === 'inline') api.inline = [inlineComment({ id: 9, body })];
      else if (category === 'issue') api.issues = [issueComment({ body })];
      else api.reviews = [review({ id: 9, body })];
      const preview = await executeTool(tools, 'pr_comments', {});
      const records = preview[
        category === 'inline'
          ? 'inlineComments'
          : category === 'issue'
            ? 'issueComments'
            : 'reviews'
      ] as RecordValue[];
      expect(records[0]).toMatchObject({
        bodyTruncated: true,
        originalLength: body.length,
        retrieval: { tool: 'pr_comment', category, id: 9, offset: 0 },
      });
      expect(new TextEncoder().encode(records[0].body as string).length).toBeLessThanOrEqual(
        MAX_COMMENT_BODY_LENGTH
      );
      let result = await executeTool(tools, 'pr_comment', { category, id: 9 });
      let recovered = result.body as string;
      while (result.nextOffset !== null) {
        result = await executeTool(tools, 'pr_comment', {
          category,
          id: 9,
          offset: result.nextOffset,
          bodyHash: result.bodyHash,
        });
        recovered += result.body as string;
      }
      expect(recovered).toBe(body);
      expect(onContextIncomplete).not.toHaveBeenCalled();
    }
  );

  it('does not return comments belonging to another PR even when their numeric ID exists', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.issues = [
      issueComment({ issue_url: 'https://api.github.com/repos/acme/widget/issues/41' }),
    ];
    await expect(executeTool(tools, 'pr_comment', { category: 'issue', id: 9 })).rejects.toThrow(
      'does not belong'
    );
    expect(onContextIncomplete).toHaveBeenCalledOnce();
  });

  it('does not combine long-comment chunks across intervening edits', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.issues = [issueComment({ body: 'x'.repeat(50_000) })];
    const first = await executeTool(tools, 'pr_comment', { category: 'issue', id: 9 });
    api.issues[0].body = 'y'.repeat(50_000);
    await expect(
      executeTool(tools, 'pr_comment', {
        category: 'issue',
        id: 9,
        offset: first.nextOffset,
        bodyHash: first.bodyHash,
      })
    ).rejects.toThrow('Comment body changed');
    expect(onContextIncomplete).toHaveBeenCalledOnce();
  });

  it('automatically discovers a summary beyond 100 issue comments without granting mutation authority', async () => {
    const { tools, api, onContextIncomplete } = setup({ input: { ...input, dryRun: true } });
    api.issues = Array.from({ length: 205 }, (_, index) => issueComment({ id: index + 1 }));
    api.issues.push(issueComment({ id: 999, body: oldSummary, user: kiloBotUser }));
    api.reviews = Array.from({ length: 225 }, (_, index) =>
      review({ id: index + 1, body: 'Review' })
    );
    const preview = await executeTool(tools, 'pr_comments', {});
    expect(preview).toMatchObject({
      issueCommentCount: 206,
      summaryCount: 1,
      summaries: [expect.objectContaining({ id: 999 })],
      reviewsComplete: false,
      truncated: true,
    });
    expect(await executeTool(tools, 'pr_comments', { category: 'reviews', page: 3 })).toMatchObject(
      { comments: expect.any(Array), nextPage: null, complete: false }
    );
    const thirdIssuePage = await executeTool(tools, 'pr_comments', { category: 'issue', page: 3 });
    expect(thirdIssuePage.comments).toHaveLength(6);
    expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
      dryRun: true,
      publishable: false,
      blockedReason: expect.stringContaining('ownership is unknown'),
    });
    expect(onContextIncomplete).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
  });

  it('builds a complete active-root index beyond 500 replies, independently of displayed previews', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.inline = Array.from({ length: 650 }, (_, index) =>
      inlineComment({ id: index + 1, in_reply_to_id: 999, body: `Reply ${index}` })
    );
    api.inline.push(inlineComment({ id: 999, body: 'Issue' }));
    const preview = await executeTool(tools, 'pr_comments', {});
    expect(preview).toMatchObject({
      inlineCommentsComplete: true,
      activeRootIndexComplete: true,
      inlineRecordCount: 651,
      inlineRootCount: 1,
      activeRootCount: 1,
      truncated: true,
    });
    expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
      error: expect.stringContaining('exact active inline comment'),
    });
    expect(writes(api)).toEqual([]);
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it('reports exhausted inline traversal as incomplete, never a complete empty index', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.inline = Array.from({ length: MAX_CONTEXT_RECORDS + 1 }, (_, index) =>
      inlineComment({ id: index + 1, in_reply_to_id: 9 })
    );
    await expect(executeTool(tools, 'pr_comments', {})).rejects.toThrow('50-page');
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(
      api.requests.filter(request => request.url.pathname === `${pullPath}/comments`)
    ).toHaveLength(MAX_GITHUB_PAGES);
    expect(await executeTool(tools, 'submit_review', args)).toMatchObject({ publishable: false });
    expect(writes(api)).toEqual([]);
  });

  it('bounds total consumed traversal bytes, not just record count', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.inline = Array.from({ length: 600 }, (_, index) =>
      inlineComment({ id: index + 1, body: 'x'.repeat(20_000), in_reply_to_id: 999 })
    );
    await expect(executeTool(tools, 'pr_comments', {})).rejects.toThrow('8 MiB');
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(
      api.requests.filter(request => request.url.pathname === `${pullPath}/comments`).length
    ).toBeLessThan(6);
  });

  it('keeps metadata-heavy UTF-8 previews bounded and exposes within-page continuations', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.inline = Array.from({ length: 100 }, (_, index) =>
      inlineComment({
        id: index + 1,
        path: `${'x'.repeat(4_000)}-${index}`,
        html_url: `https://github.com/${'x'.repeat(1_900)}`,
        body: 'é'.repeat(1_000),
      })
    );
    const first = await executeTool(tools, 'pr_comments', { category: 'inline' });
    expect((first.comments as unknown[]).length).toBeLessThan(100);
    expect(first).toMatchObject({ nextPage: 1, nextOffset: expect.any(Number), complete: false });
    expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(132_000);
    const second = await executeTool(tools, 'pr_comments', first.continuation);
    expect((second.comments as RecordValue[])[0]?.id).toBe(Number(first.nextOffset) + 1);
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it.each(['inline', 'issue', 'reviews'] as const)(
    'rejects malformed required %s comment fields',
    async category => {
      const { tools, api, onContextIncomplete } = setup();
      if (category === 'inline') api.inline = [{ id: 14, body: 'unproven' }];
      else if (category === 'issue') api.issues = [{ id: 9, body: null }];
      else api.reviews = [{ id: 91 }];
      await expect(executeTool(tools, 'pr_comments', {})).rejects.toThrow(
        'invalid required response fields'
      );
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(writes(api)).toEqual([]);
    }
  );

  it('retries a transient read only once and keeps repeated failure incomplete', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.override = url =>
      url.pathname === pullPath ? new Response('unavailable', { status: 503 }) : undefined;
    await expect(executeTool(tools, 'pr_view', {})).rejects.toThrow('Required GitHub context');
    expect(api.requests).toHaveLength(2);
    expect(onContextIncomplete).toHaveBeenCalledOnce();
  });

  it('does not retry a rate-limited read', async () => {
    const { tools, api } = setup();
    api.override = () => new Response('rate limited', { status: 429 });
    await expect(executeTool(tools, 'pr_view', {})).rejects.toThrow();
    expect(api.requests).toHaveLength(1);
  });
});

describe('read-only summary cleaning', () => {
  const literalMarkers = [
    '<!-- kilo-usage -->',
    '<!-- kilo-review-guidance -->',
    '<!-- kilo-review-history -->',
    '<!-- /kilo-review-history -->',
    '<!-- kilo-review-history-entry -->',
  ];

  it.each(literalMarkers)(
    'preserves literal %s mentions and findings in previews and full retrieval',
    async marker => {
      const { tools, api } = setup();
      const visible = `${oldSummary}\nMentions \`${marker}\` as text.\n\nCurrent finding after the marker.`;
      const operationMarker = `<!-- kilo-isolate-review-summary:${await hash(runId)} -->`;
      const body = `${visible}\n\n${summaryHistory}\n\n${summaryFooter}\n${operationMarker}`;
      api.issues = [issueComment({ body, user: kiloBotUser })];
      const expected = {
        body: visible,
        bodyTruncated: false,
        originalLength: body.length,
        originalBytes: new TextEncoder().encode(body).byteLength,
        contextLength: visible.length,
        serverOwnedBlocksExcluded: true,
      };
      expect(await executeTool(tools, 'pr_comments', {})).toMatchObject({
        summaries: [expect.objectContaining(expected)],
        issueComments: [expect.objectContaining(expected)],
      });
      expect(await executeTool(tools, 'pr_comments', { category: 'issue' })).toMatchObject({
        comments: [expect.objectContaining(expected)],
      });
      expect(await executeTool(tools, 'pr_comment', { category: 'issue', id: 9 })).toMatchObject({
        ...expected,
        bodyHash: await hash(body),
        nextOffset: null,
      });
      expect(api.issues[0].body).toBe(body);
      expect(writes(api)).toEqual([]);
    }
  );

  it.each(literalMarkers)(
    'retains an unpaired %s and subsequent findings without relaxing mutation guards',
    async marker => {
      const body = `${oldSummary}\n${marker}\nCurrent finding after an unpaired marker.`;
      const { tools, api } = await ownedSetup(body);
      const expected = {
        body,
        contextLength: body.length,
        serverOwnedBlocksExcluded: false,
        bodyTruncated: false,
      };
      expect(await executeTool(tools, 'pr_comments', {})).toMatchObject({
        summaries: [expect.objectContaining(expected)],
      });
      expect(await executeTool(tools, 'pr_comment', { category: 'issue', id: 9 })).toMatchObject({
        ...expected,
        bodyHash: await hash(body),
      });
      expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
        publishable: false,
        blockedReason: expect.stringContaining('server-owned'),
      });
      expect(writes(api)).toEqual([]);
    }
  );

  it('recovers all cleaned summary chunks using raw-body hashes and context offsets', async () => {
    const { tools, api, onContextIncomplete } = setup();
    const visible = `${oldSummary}\nMentions <!-- kilo-usage --> as text.\nCurrent finding\n${'é'.repeat(40_000)}\nFinal finding after the long summary`;
    const body = `${visible}\n\n${summaryHistory}\n\n${summaryFooter}\n<!-- kilo-isolate-review-summary:${await hash(runId)} -->`;
    api.issues = [issueComment({ body, user: kiloBotUser })];
    const preview = await executeTool(tools, 'pr_comments', {});
    const summaries = preview.summaries as RecordValue[];
    expect(summaries[0]).toMatchObject({
      bodyTruncated: true,
      originalLength: body.length,
      contextLength: visible.length,
      serverOwnedBlocksExcluded: true,
    });
    expect(summaries[0].body).toContain('Current finding');
    expect(new TextEncoder().encode(summaries[0].body as string).byteLength).toBeLessThanOrEqual(
      MAX_COMMENT_BODY_LENGTH
    );
    const rawHash = await hash(body);
    let result = await executeTool(tools, 'pr_comment', { category: 'issue', id: 9 });
    expect(result).toMatchObject({ bodyHash: rawHash, nextOffset: expect.any(Number) });
    expect(result.bodyHash).not.toBe(await hash(visible));
    let recovered = result.body as string;
    while (result.nextOffset !== null) {
      result = await executeTool(tools, 'pr_comment', result.retrieval);
      expect(result).toMatchObject({
        bodyHash: rawHash,
        offset: recovered.length,
        contextLength: visible.length,
        originalLength: body.length,
        originalBytes: new TextEncoder().encode(body).byteLength,
        serverOwnedBlocksExcluded: true,
      });
      expect(new TextEncoder().encode(result.body as string).byteLength).toBeLessThanOrEqual(
        MAX_RETRIEVAL_BYTES
      );
      recovered += result.body as string;
    }
    expect(recovered).toBe(visible);
    expect(api.issues[0].body).toBe(body);
    expect(onContextIncomplete).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
  });

  it('rejects a continuation after only the excluded footer changes', async () => {
    const { tools, api, onContextIncomplete } = setup();
    const visible = `${oldSummary}\n${'é'.repeat(20_000)}\nFinal finding`;
    const body = `${visible}\n\n${summaryHistory}\n\n${summaryFooter}`;
    api.issues = [issueComment({ body, user: kiloBotUser })];
    const first = await executeTool(tools, 'pr_comment', { category: 'issue', id: 9 });
    expect(first).toMatchObject({ bodyHash: await hash(body), nextOffset: expect.any(Number) });
    api.issues[0].body = body.replace('Reviewed by model', 'Reviewed by another-model');
    const changed = await executeTool(tools, 'pr_comment', { category: 'issue', id: 9 });
    expect(changed.body).toBe(first.body);
    expect(changed.bodyHash).not.toBe(first.bodyHash);
    await expect(executeTool(tools, 'pr_comment', first.retrieval)).rejects.toThrow(
      'Comment body changed'
    );
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(writes(api)).toEqual([]);
  });
});

describe.each([
  {
    mode: 'full',
    reviewSelection: undefined,
    oldSha: snapshot.mergeBaseSha,
    revision: 'merge-base',
  },
  {
    mode: 'incremental',
    reviewSelection: incrementalSelection,
    oldSha: previousHeadSha,
    revision: 'previous',
  },
])('$mode metadata-only rename completeness', ({ reviewSelection, oldSha, revision }) => {
  const path = 'src/new.ts';
  const oldPath = reviewSelection ? 'src/previous.ts' : 'src/original.ts';

  function renamedSetup(patch: string | undefined, extra: Partial<ToolOptions> = {}) {
    const fixture = setup({ reviewSelection, ...extra });
    const file = diffFile({
      filename: path,
      previous_filename: oldPath,
      status: 'renamed',
      additions: 0,
      deletions: 0,
      changes: 0,
      patch,
    });
    fixture.api.deltaFiles = [file];
    fixture.api.files = [{ ...file, previous_filename: 'src/original.ts' }];
    gitSnapshot(fixture.api, snapshot.headSha, [{ path }]);
    gitSnapshot(fixture.api, snapshot.mergeBaseSha, [{ path: 'src/original.ts' }]);
    if (reviewSelection) gitSnapshot(fixture.api, oldSha, [{ path: oldPath }]);
    fixture.api.contents.set(`${snapshot.headSha}:${path}`, content(path, 'unchanged file'));
    fixture.api.contents.set(`${oldSha}:${oldPath}`, content(oldPath, 'unchanged file'));
    fixture.api.contents.set(
      `${snapshot.mergeBaseSha}:src/original.ts`,
      content('src/original.ts', 'unchanged file')
    );
    fixture.api.contents.set(`${snapshot.baseTipSha}:${oldPath}`, {
      ...content(oldPath, 'base branch changed independently'),
      sha: '9'.repeat(40),
    });
    return fixture;
  }

  it.each([undefined, ''])(
    'completes a blob-verified rename with patch %s without authorizing an anchor',
    async patch => {
      for (const dryRun of [false, true]) {
        const { tools, api, onContextIncomplete, onProposal } = renamedSetup(patch, {
          input: { ...input, dryRun },
        });
        await executeTool(tools, 'pr_view', {});
        expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
          snapshot,
          filesComplete: true,
          patchesComplete: true,
          contextComplete: true,
          truncated: false,
          files: [
            expect.objectContaining({
              filename: path,
              oldPath,
              oldRevision: revision,
              patch: '',
              patchStatus: 'available',
              patchComplete: true,
            }),
          ],
        });
        expect(await executeTool(tools, 'pr_file', { path, revision: 'head' })).toMatchObject({
          path,
          sha: snapshot.headSha,
          blobSha: 'd'.repeat(40),
          body: 'unchanged file',
        });
        expect(await executeTool(tools, 'pr_file', { path, revision })).toMatchObject({
          path: oldPath,
          sha: oldSha,
          blobSha: 'd'.repeat(40),
          body: 'unchanged file',
        });
        expect(await executeTool(tools, 'pr_file_patch', { path })).toMatchObject({
          body: '',
          patchComplete: true,
          contextComplete: true,
          bodyTruncated: false,
          nextOffset: null,
        });
        expect(
          await executeTool(tools, 'submit_review', { comments: [{ ...finding, path }] })
        ).toMatchObject({
          error: expect.stringContaining('No current RIGHT-side diff target'),
        });
        expect(onContextIncomplete).not.toHaveBeenCalled();
        expect(onProposal).not.toHaveBeenCalled();
        expect(writes(api)).toEqual([]);
        const summary = await executeTool(tools, 'upsert_summary', {
          body: 'Metadata-only rename reviewed',
        });
        expect(summary).toMatchObject(dryRun ? { dryRun: true, publishable: true } : { id: 1_000 });
        expect(onProposal).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'summary', publishable: true })
        );
        expect(
          api.requests.some(({ url }) => url.searchParams.get('ref') === snapshot.baseTipSha)
        ).toBe(false);
      }
    }
  );

  it.each([
    {
      label: 'binary bytes',
      metadata: { encoding: 'base64', content: btoa('\0\xffbinary'), size: 8 },
    },
    { label: 'large file', metadata: { encoding: 'none', content: '', size: MAX_FILE_BYTES + 1 } },
    { label: 'large executable', metadata: { size: 200 * MAX_FILE_BYTES, mode: '100755' } },
  ])('proves unchanged $label without decoding file content', async ({ metadata }) => {
    for (const patch of [undefined, '']) {
      const { tools, api, onContextIncomplete } = renamedSetup(patch, {
        reviewSelection: reviewSelection ? { ...reviewSelection, changedFileCount: 2 } : undefined,
      });
      api.files.push(diffFile());
      api.deltaFiles.push(diffFile());
      for (const [sha, filename] of [
        [snapshot.headSha, path],
        [oldSha, oldPath],
        [snapshot.mergeBaseSha, 'src/original.ts'],
      ]) {
        api.contents.set(`${sha}:${filename}`, {
          type: 'file',
          path: filename,
          sha: 'd'.repeat(40),
          ...metadata,
        });
        gitSnapshot(api, sha, [
          {
            path: filename,
            size: metadata.size,
            mode: 'mode' in metadata ? metadata.mode : '100644',
          },
        ]);
      }
      expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
        patchesComplete: true,
        contextComplete: true,
      });
      expect(await executeTool(tools, 'pr_file_patch', { path })).toMatchObject({
        body: '',
        patchComplete: true,
        contextComplete: true,
      });
      expect(
        await executeTool(tools, 'submit_review', { comments: [{ ...finding, path }] })
      ).toMatchObject({ error: expect.stringContaining('No current RIGHT-side diff target') });
      expect(writes(api)).toEqual([]);
      expect(await executeTool(tools, 'submit_review', args)).toEqual({ id: 1_000 });
      expect(
        await executeTool(tools, 'upsert_summary', {
          body: 'Metadata-only rename and unrelated defect reviewed',
        })
      ).toHaveProperty('id');
      expect(onContextIncomplete).not.toHaveBeenCalled();
      expect(writes(api)).toHaveLength(2);
      expect(api.requests.some(({ url }) => /\/(?:contents|git\/blobs)\//.test(url.pathname))).toBe(
        false
      );
    }
  });

  it('rejects a moved relative symlink even when Contents dereferences it to type:file with the link SHA', async () => {
    const { tools, api, onContextIncomplete, onProposal } = renamedSetup(undefined);
    const oldLink = 'original/RelNotes';
    const newLink = 'moved/RelNotes';
    const link = diffFile({
      filename: newLink,
      previous_filename: oldLink,
      status: 'renamed',
      additions: 0,
      deletions: 0,
      changes: 0,
      patch: undefined,
    });
    api.files = [link];
    api.deltaFiles = [link];
    for (const [sha, filename, text] of [
      [oldSha, oldLink, 'old dereferenced target'],
      [snapshot.headSha, newLink, 'different dereferenced target'],
    ]) {
      gitSnapshot(api, sha, [{ path: filename, mode: '120000' }]);
      api.contents.set(`${sha}:${filename}`, content(filename, text));
    }
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      patchesComplete: false,
      contextComplete: false,
    });
    expect(await executeTool(tools, 'upsert_summary', { body: 'No findings' })).toMatchObject({
      publishable: false,
    });
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(onProposal).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
    expect(api.requests.some(({ url }) => url.pathname.includes('/contents/'))).toBe(false);
  });

  it.each([
    ['100644', '100755'],
    ['100755', '100644'],
  ])('keeps a rename with mode change %s to %s incomplete', async (oldMode, newMode) => {
    const { tools, api, onContextIncomplete } = renamedSetup('');
    gitSnapshot(api, oldSha, [{ path: oldPath, mode: oldMode }]);
    gitSnapshot(api, snapshot.headSha, [{ path, mode: newMode }]);
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      patchesComplete: false,
      contextComplete: false,
    });
    expect(await executeTool(tools, 'upsert_summary', { body: 'No findings' })).toMatchObject({
      publishable: false,
    });
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(writes(api)).toEqual([]);
  });

  it.each([
    { mode: '120000', type: 'blob' },
    { mode: '100644', type: 'blob' },
    { mode: '160000', type: 'commit' },
    { mode: '040000', type: 'blob' },
    { mode: 'unknown', type: 'tree' },
  ])('never follows non-directory or malformed ancestors', async metadata => {
    for (const [sha, filename] of [
      [oldSha, oldPath],
      [snapshot.headSha, path],
    ]) {
      const { tools, api, onContextIncomplete } = renamedSetup(undefined);
      const { root } = gitSnapshot(api, sha, [{ path: filename }]);
      const ancestor = root.tree[0];
      if (!ancestor || typeof ancestor.sha !== 'string')
        throw new Error('Missing fixture ancestor');
      const childSha = ancestor.sha;
      root.tree[0] = { ...ancestor, ...metadata };
      expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
        patchesComplete: false,
        contextComplete: false,
      });
      expect(
        api.requests.some(({ url }) => url.pathname === `${repositoryPath}/git/trees/${childSha}`)
      ).toBe(false);
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(writes(api)).toEqual([]);
    }
  });

  it('allows an unrelated real finding after the renamed file evidence is complete', async () => {
    const { tools, api, onContextIncomplete } = renamedSetup(undefined, {
      reviewSelection: reviewSelection ? { ...reviewSelection, changedFileCount: 2 } : undefined,
    });
    api.files.push(diffFile());
    api.deltaFiles.push(diffFile());
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      patchesComplete: true,
      contextComplete: true,
    });
    expect(await executeTool(tools, 'submit_review', args)).toEqual({ id: 1_000 });
    expect(
      await executeTool(tools, 'upsert_summary', { body: 'One unrelated defect found' })
    ).toHaveProperty('id');
    expect(writes(api)).toHaveLength(2);
    expect(writes(api)[0]?.body).toMatchObject({ comments: [finding] });
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'modified', previous_filename: undefined },
    { additions: 1, changes: 1 },
    { patch: '@@ -1 +1 @@\n+' },
    { previous_filename: path },
  ])(
    'does not infer metadata-only completeness from zero totals or malformed patches',
    async overrides => {
      const { tools, api, onContextIncomplete } = renamedSetup('');
      api.files = api.files.map(file => ({ ...file, ...overrides }));
      api.deltaFiles = api.deltaFiles.map(file => ({ ...file, ...overrides }));
      expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
        patchesComplete: false,
        contextComplete: false,
      });
      expect(api.requests.some(({ url }) => /\/(?:contents|git)\//.test(url.pathname))).toBe(false);
      expect(onContextIncomplete).toHaveBeenCalledOnce();
    }
  );

  it('rejects an unsafe previous filename before requesting rename content', async () => {
    const { tools, api, onContextIncomplete } = renamedSetup(undefined);
    api.files = api.files.map(file => ({ ...file, previous_filename: '../outside.ts' }));
    api.deltaFiles = api.deltaFiles.map(file => ({ ...file, previous_filename: '../outside.ts' }));
    await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow();
    expect(api.requests.some(({ url }) => /\/(?:contents|git)\//.test(url.pathname))).toBe(false);
    expect(onContextIncomplete).toHaveBeenCalledOnce();
  });

  it('preserves cancellation during rename proof without recording an incomplete context', async () => {
    const { tools, api, onContextIncomplete } = renamedSetup(undefined);
    const controller = new AbortController();
    api.override = url => {
      if (url.pathname.includes('/git/')) controller.abort();
      return undefined;
    };
    await expect(executeTool(tools, 'pr_diff', {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(api.requests.filter(({ url }) => url.pathname.includes('/git/'))).toHaveLength(1);
    expect(onContextIncomplete).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
  });

  it('refuses publication when the head moves during rename proof', async () => {
    const { tools, api, onContextIncomplete } = renamedSetup(undefined);
    api.override = url => {
      if (url.pathname.includes('/git/')) api.pull.head = { sha: '9'.repeat(40) };
      return undefined;
    };
    await expect(executeTool(tools, 'pr_diff', {})).rejects.toThrow('head changed');
    expect(await executeTool(tools, 'upsert_summary', { body: 'No findings' })).toMatchObject({
      publishable: false,
    });
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(writes(api)).toEqual([]);
  });

  it.each(['old', 'head', 'both'] as const)(
    'keeps %s blob identity mismatches incomplete',
    async side => {
      const { tools, api, onContextIncomplete, onProposal } = renamedSetup(undefined);
      if (side !== 'head') gitSnapshot(api, oldSha, [{ path: oldPath, sha: '9'.repeat(40) }]);
      if (side !== 'old') gitSnapshot(api, snapshot.headSha, [{ path, sha: '9'.repeat(40) }]);
      expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
        patchesComplete: false,
        contextComplete: false,
      });
      await executeTool(tools, 'pr_file', { path, revision: 'head' });
      await executeTool(tools, 'pr_file', { path, revision });
      expect(await executeTool(tools, 'upsert_summary', { body: 'No findings' })).toMatchObject({
        publishable: false,
      });
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(onProposal).not.toHaveBeenCalled();
      expect(writes(api)).toEqual([]);
    }
  );

  it.each([
    { label: 'missing file', metadata: undefined },
    { label: 'wrong path', metadata: { path: 'elsewhere.ts' } },
    { label: 'invalid identity', metadata: { sha: 'invalid' } },
    { label: 'missing identity', metadata: { sha: undefined } },
    { label: 'directory', metadata: { type: 'tree', mode: '040000' } },
    { label: 'symlink', metadata: { type: 'blob', mode: '120000' } },
    { label: 'submodule', metadata: { type: 'commit', mode: '160000' } },
    { label: 'unknown mode', metadata: { mode: '100664' } },
    { label: 'missing mode', metadata: { mode: undefined } },
    { label: 'unknown type', metadata: { type: 'file' } },
    { label: 'mismatched type and mode', metadata: { type: 'commit', mode: '100644' } },
  ])('keeps an unprovable $label incomplete', async ({ metadata }) => {
    for (const [sha, filename] of [
      [oldSha, oldPath],
      [snapshot.headSha, path],
    ]) {
      const { tools, api, onContextIncomplete, onProposal } = renamedSetup('');
      gitSnapshot(api, sha, metadata ? [{ path: filename, ...metadata }] : []);
      expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
        patchesComplete: false,
        contextComplete: false,
      });
      expect(await executeTool(tools, 'upsert_summary', { body: 'No findings' })).toMatchObject({
        publishable: false,
      });
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(onProposal).not.toHaveBeenCalled();
      expect(writes(api)).toEqual([]);
      expect(api.requests.some(({ url }) => url.pathname.includes('/contents/'))).toBe(false);
    }
  });

  it.each([
    { label: 'missing commit', kind: 'commit', metadata: undefined },
    { label: 'wrong commit identity', kind: 'commit', metadata: { sha: '9'.repeat(40) } },
    { label: 'missing root tree', kind: 'commit', metadata: { tree: undefined } },
    { label: 'invalid root identity', kind: 'commit', metadata: { tree: { sha: 'invalid' } } },
    { label: 'missing tree', kind: 'tree', metadata: undefined },
    { label: 'wrong tree identity', kind: 'tree', metadata: { sha: '9'.repeat(40) } },
    { label: 'truncated tree', kind: 'tree', metadata: { truncated: true } },
    { label: 'unknown tree completeness', kind: 'tree', metadata: { truncated: undefined } },
    { label: 'missing tree entries', kind: 'tree', metadata: { tree: undefined } },
    {
      label: 'recursive entries',
      kind: 'tree',
      metadata: {
        tree: [{ path: 'src/nested', sha: 'd'.repeat(40), mode: '100644', type: 'blob' }],
      },
    },
  ])('rejects $label without falling back to Contents', async ({ kind, metadata }) => {
    for (const [sha, filename] of [
      [oldSha, oldPath],
      [snapshot.headSha, path],
    ]) {
      const { tools, api, onContextIncomplete } = renamedSetup(undefined);
      const { root, commit } = gitSnapshot(api, sha, [{ path: filename }]);
      const records = kind === 'commit' ? api.gitCommits : api.gitTrees;
      const original = kind === 'commit' ? commit : root;
      if (metadata) records.set(original.sha, { ...original, ...metadata });
      else records.delete(original.sha);
      expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
        patchesComplete: false,
        contextComplete: false,
      });
      expect(await executeTool(tools, 'upsert_summary', { body: 'No findings' })).toMatchObject({
        publishable: false,
      });
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(api.requests.some(({ url }) => url.pathname.includes('/contents/'))).toBe(false);
      expect(writes(api)).toEqual([]);
    }
  });

  it.each(['duplicate', 'cycle'])('rejects %s tree entries', async failure => {
    const { tools, api, onContextIncomplete } = renamedSetup(undefined);
    const { root } = gitSnapshot(api, oldSha, [{ path: oldPath }]);
    if (failure === 'duplicate') root.tree.push({ ...root.tree[0] });
    else root.tree = [{ path: 'src', mode: '040000', type: 'tree', sha: root.sha }];
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      patchesComplete: false,
      contextComplete: false,
    });
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(writes(api)).toEqual([]);
  });
});

describe('bounded metadata-only rename proof', () => {
  it.each([false, true])(
    'bounds physical Git metadata requests including retries=%s',
    async retries => {
      const { tools, api, onContextIncomplete } = setup();
      const paths = Array.from({ length: MAX_RENAME_PROOF_REQUESTS }, (_, index) => ({
        filename: `new-${index}/file.ts`,
        previous_filename: `old-${index}/file.ts`,
      }));
      api.files = paths.map(paths =>
        diffFile({
          ...paths,
          status: 'renamed',
          additions: 0,
          deletions: 0,
          changes: 0,
          patch: undefined,
        })
      );
      gitSnapshot(
        api,
        snapshot.headSha,
        paths.map(({ filename }) => ({ path: filename }))
      );
      gitSnapshot(
        api,
        snapshot.mergeBaseSha,
        paths.map(({ previous_filename }) => ({ path: previous_filename }))
      );
      const attempted = new Set<string>();
      api.override = url => {
        if (retries && url.pathname.includes('/git/') && !attempted.has(url.pathname)) {
          attempted.add(url.pathname);
          return new Response('Temporary failure', { status: 503 });
        }
        return undefined;
      };
      expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
        filesComplete: true,
        patchesComplete: false,
        contextComplete: false,
      });
      expect(api.requests.filter(({ url }) => url.pathname.includes('/git/'))).toHaveLength(
        MAX_RENAME_PROOF_REQUESTS
      );
      await executeTool(tools, 'pr_diff', {});
      expect(api.requests.filter(({ url }) => url.pathname.includes('/git/'))).toHaveLength(
        MAX_RENAME_PROOF_REQUESTS
      );
      expect(await executeTool(tools, 'upsert_summary', { body: 'No findings' })).toMatchObject({
        publishable: false,
      });
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(writes(api)).toEqual([]);
    }
  );

  it('bounds aggregate cached Git metadata bytes', async () => {
    const { tools, api, onContextIncomplete } = setup();
    const paths = Array.from({ length: 10 }, (_, index) => ({
      filename: `new-${index}/file.ts`,
      previous_filename: `old-${index}/file.ts`,
    }));
    api.files = paths.map(paths =>
      diffFile({
        ...paths,
        status: 'renamed',
        additions: 0,
        deletions: 0,
        changes: 0,
        patch: undefined,
      })
    );
    gitSnapshot(
      api,
      snapshot.headSha,
      paths.map(({ filename }) => ({ path: filename }))
    );
    gitSnapshot(
      api,
      snapshot.mergeBaseSha,
      paths.map(({ previous_filename }) => ({ path: previous_filename }))
    );
    api.override = url => {
      const tree = api.gitTrees.get(url.pathname.slice(`${repositoryPath}/git/trees/`.length));
      return tree ? Response.json({ ...tree, padding: 'x'.repeat(MAX_FILE_BYTES) }) : undefined;
    };
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      patchesComplete: false,
      contextComplete: false,
    });
    expect(
      api.requests.filter(({ url }) => url.pathname.includes('/git/trees/')).length
    ).toBeLessThanOrEqual(MAX_GITHUB_TRAVERSAL_BYTES / MAX_FILE_BYTES);
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(writes(api)).toEqual([]);
  });

  it.each(['record cap', 'pagination'])(
    'refuses tree evidence exceeding the %s completeness bound',
    async failure => {
      const { tools, api, onContextIncomplete } = setup();
      api.files = [
        diffFile({
          filename: 'new.ts',
          previous_filename: 'old.ts',
          status: 'renamed',
          additions: 0,
          deletions: 0,
          changes: 0,
          patch: undefined,
        }),
      ];
      gitSnapshot(api, snapshot.headSha, [{ path: 'new.ts' }]);
      const { root } = gitSnapshot(api, snapshot.mergeBaseSha, [{ path: 'old.ts' }]);
      if (failure === 'record cap') {
        root.tree.push(
          ...Array.from({ length: MAX_CONTEXT_RECORDS }, (_, index) => ({
            path: `other-${index}`,
            sha: 'd'.repeat(40),
            mode: '100644',
            type: 'blob',
          }))
        );
      } else {
        api.override = url =>
          url.pathname === `${repositoryPath}/git/trees/${root.sha}`
            ? Response.json(root, { headers: { Link: `<${url.href}?page=2>; rel="next"` } })
            : undefined;
      }
      expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
        patchesComplete: false,
        contextComplete: false,
      });
      expect(onContextIncomplete).toHaveBeenCalledOnce();
      expect(writes(api)).toEqual([]);
    }
  );

  it('shares immutable commit and directory lookups across many concurrent renames', async () => {
    const { tools, api, onContextIncomplete } = setup();
    const paths = Array.from({ length: 100 }, (_, index) => ({
      filename: `src/new-${index}.ts`,
      previous_filename: `src/old-${index}.ts`,
    }));
    api.files = paths.map(paths =>
      diffFile({
        ...paths,
        status: 'renamed',
        additions: 0,
        deletions: 0,
        changes: 0,
        patch: undefined,
      })
    );
    gitSnapshot(
      api,
      snapshot.headSha,
      paths.map(({ filename }) => ({ path: filename }))
    );
    gitSnapshot(
      api,
      snapshot.mergeBaseSha,
      paths.map(({ previous_filename }) => ({ path: previous_filename }))
    );
    const controller = new AbortController();
    const results = await Promise.all([
      executeTool(tools, 'pr_diff', {}, controller.signal),
      executeTool(tools, 'pr_diff', {}, controller.signal),
    ]);
    for (const result of results)
      expect(result).toMatchObject({ patchesComplete: true, contextComplete: true });
    expect(api.requests.filter(({ url }) => url.pathname.includes('/git/'))).toHaveLength(6);
    expect(
      api.requests
        .filter(({ url }) => url.pathname.includes('/git/commits/'))
        .map(({ url }) => url.pathname)
    ).toEqual([
      `${repositoryPath}/git/commits/${snapshot.mergeBaseSha}`,
      `${repositoryPath}/git/commits/${snapshot.headSha}`,
    ]);
    expect(
      api.requests.some(
        ({ url }) => url.searchParams.has('recursive') || url.pathname.includes('/contents/')
      )
    ).toBe(false);
    expect(
      api.requests.every(
        ({ init }) => new Headers(init.headers).get('Accept') === 'application/vnd.github+json'
      )
    ).toBe(true);
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it('does not share cancellation between different in-flight callers', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.files = [
      diffFile({
        filename: 'new.ts',
        previous_filename: 'old.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        changes: 0,
        patch: undefined,
      }),
    ];
    gitSnapshot(api, snapshot.headSha, [{ path: 'new.ts' }]);
    gitSnapshot(api, snapshot.mergeBaseSha, [{ path: 'old.ts' }]);
    const cancelled = new AbortController();
    const continuing = new AbortController();
    api.override = (url, init) => {
      if (url.pathname.includes('/git/') && init.signal === cancelled.signal) cancelled.abort();
      return undefined;
    };
    const [aborted, completed] = await Promise.allSettled([
      executeTool(tools, 'pr_diff', {}, cancelled.signal),
      executeTool(tools, 'pr_diff', {}, continuing.signal),
    ]);
    expect(aborted).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ name: 'AbortError' }),
    });
    expect(completed).toMatchObject({
      status: 'fulfilled',
      value: { patchesComplete: true, contextComplete: true },
    });
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it('proves guarded PR-files renames against the merge base', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.files.push(
      diffFile({
        filename: 'new.ts',
        previous_filename: 'old.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        changes: 0,
        patch: undefined,
      })
    );
    api.compareFiles = [];
    gitSnapshot(api, snapshot.headSha, [{ path: 'new.ts' }]);
    gitSnapshot(api, snapshot.mergeBaseSha, [{ path: 'old.ts' }]);
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      source: 'guarded-pr-files',
      filesComplete: true,
      patchesComplete: true,
      contextComplete: true,
    });
    expect(await executeTool(tools, 'upsert_summary', { body: 'Reviewed' })).toHaveProperty('id');
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });

  it('does not share incremental rename proof with a different current-PR old revision', async () => {
    const { tools, api, onContextIncomplete } = setup({ reviewSelection: incrementalSelection });
    const file = diffFile({
      filename: 'new.ts',
      previous_filename: 'old.ts',
      status: 'renamed',
      additions: 0,
      deletions: 0,
      changes: 0,
      patch: undefined,
    });
    api.files = [file];
    api.deltaFiles = [file];
    gitSnapshot(api, snapshot.headSha, [{ path: 'new.ts' }]);
    gitSnapshot(api, previousHeadSha, [{ path: 'old.ts' }]);
    gitSnapshot(api, snapshot.mergeBaseSha, [{ path: 'old.ts', sha: '9'.repeat(40) }]);
    expect(await executeTool(tools, 'pr_diff', {})).toMatchObject({
      patchesComplete: true,
      contextComplete: true,
    });
    expect(await executeTool(tools, 'pr_diff', { comparison: 'current-pr' })).toMatchObject({
      patchesComplete: false,
      contextComplete: true,
    });
    expect(
      await executeTool(tools, 'submit_review', { comments: [{ ...finding, path: 'new.ts' }] })
    ).toMatchObject({ error: expect.stringContaining('No current RIGHT-side diff target') });
    expect(
      await executeTool(tools, 'upsert_summary', { body: 'Selected delta reviewed' })
    ).toHaveProperty('id');
    expect(onContextIncomplete).not.toHaveBeenCalled();
  });
});

describe('patch completeness before clean-review proposals', () => {
  const incompleteFiles = [
    {
      label: 'truncated hunk',
      file: diffFile({ patch: '@@ -1,5 +1,6 @@\n one\n+partial' }),
      status: 'incomplete',
    },
    {
      label: 'mismatched added/deleted totals',
      file: diffFile({ additions: 3, changes: 4 }),
      status: 'incomplete',
    },
    { label: 'mismatched total changes', file: diffFile({ changes: 99 }), status: 'incomplete' },
    { label: 'missing patch', file: diffFile({ patch: undefined }), status: 'binary_or_omitted' },
  ];

  it.each(incompleteFiles)(
    'exposes $label with pinned recovery instead of available evidence',
    async ({ file, status }) => {
      const fixture = setup();
      fixture.api.files = [file];
      const result = await executeTool(fixture.tools, 'pr_diff', {});
      expect(result).toMatchObject({
        snapshot,
        filesComplete: true,
        patchesComplete: false,
        contextComplete: false,
        truncated: true,
        files: [expect.objectContaining({ patchStatus: status, patchComplete: false })],
      });
      expect((result.files as RecordValue[])[0]?.patch).toBeUndefined();
      expect(
        await executeTool(fixture.tools, 'pr_file_patch', { path: 'src/index.ts' })
      ).toMatchObject({
        patchStatus: status,
        patchComplete: false,
        contextComplete: false,
        snapshot,
        retrieval: [
          { tool: 'pr_file', path: 'src/index.ts', revision: 'head', offset: 0 },
          { tool: 'pr_file', path: 'src/index.ts', revision: 'merge-base', offset: 0 },
        ],
      });
      expect(fixture.onContextIncomplete).toHaveBeenCalledOnce();
      expect(writes(fixture.api)).toEqual([]);
    }
  );

  it.each(incompleteFiles)(
    'blocks a no-inline clean summary for $label in live and dry-run modes',
    async ({ file }) => {
      for (const dryRun of [false, true]) {
        const fixture = setup({ input: { ...input, dryRun } });
        fixture.api.files = [file];
        expect(
          await executeTool(fixture.tools, 'upsert_summary', { body: 'No issues found' })
        ).toMatchObject({ publishable: false, blockedReason: expect.stringContaining('patch') });
        expect(fixture.onContextIncomplete).toHaveBeenCalledOnce();
        expect(fixture.onProposal).not.toHaveBeenCalled();
        expect(fixture.onPublicationStarted).not.toHaveBeenCalled();
        expect(writes(fixture.api)).toEqual([]);
        const reason = fixture.onContextIncomplete.mock.calls[0]?.[0];
        if (!reason) throw new Error('Missing incomplete evidence reason');
        const recreated = fixture.create({
          publicationState: { contextIncompleteReasons: [reason] },
        });
        expect(
          await executeTool(recreated, 'upsert_summary', { body: 'No issues found' })
        ).toMatchObject({ publishable: false });
        expect(fixture.onProposal).not.toHaveBeenCalled();
      }
    }
  );

  it('does not equate raw-complete display clipping with incomplete patch evidence', async () => {
    const fixture = setup();
    const patch = `@@ -0,0 +1 @@\n+${'x'.repeat(MAX_RETRIEVAL_BYTES + 1)}`;
    fixture.api.files = [diffFile({ patch, additions: 1, deletions: 0, changes: 1 })];
    expect(await executeTool(fixture.tools, 'pr_diff', {})).toMatchObject({
      patchesComplete: true,
      contextComplete: true,
      truncated: true,
      files: [
        expect.objectContaining({
          patchStatus: 'available',
          patchComplete: true,
          bodyTruncated: true,
        }),
      ],
    });
    expect(fixture.onContextIncomplete).not.toHaveBeenCalled();
  });
});

describe('publication target and summary ownership gates', () => {
  it('publishes at the captured head with an empty review body and unchanged inline text', async () => {
    const { tools, api, onPublicationStarted, onPublished } = setup();
    const result = await executeTool(tools, 'submit_review', {
      ...args,
      body: 'Accidental review narrative',
    });
    expect(result).toEqual({ id: 1_000 });
    expect(writes(api)).toHaveLength(1);
    expect(writes(api)[0]?.body).toEqual({
      commit_id: snapshot.headSha,
      event: 'COMMENT',
      body: '',
      comments: [finding],
    });
    expect(api.reviews[0]?.body).toBe('');
    expect(onPublicationStarted).toHaveBeenCalledWith('review', {
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(onPublished).toHaveBeenCalledWith({
      kind: 'review',
      id: 1_000,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('normalizes absolute workspace paths before fingerprinting and submitting', async () => {
    const { tools, api } = setup();
    await executeTool(tools, 'submit_review', {
      comments: [{ ...finding, path: '/workspace/src/index.ts' }],
    });
    expect(writes(api)[0]?.body).toMatchObject({ comments: [finding] });
    await executeTool(tools, 'submit_review', args);
    expect(writes(api)).toHaveLength(1);
  });

  it.each([
    { path: '../secret' },
    { path: '/etc/passwd' },
    { line: 0 },
    { line: 1.5 },
    { body: '' },
    { body: '   ' },
    { side: 'LEFT' },
  ])('rejects malformed or LEFT-side targets before GitHub I/O', async override => {
    const { tools, api } = setup();
    expect(
      await executeTool(tools, 'submit_review', { comments: [{ ...finding, ...override }] })
    ).toHaveProperty('error');
    expect(api.requests).toEqual([]);
  });

  it('rejects exact duplicates inside an atomic batch after path normalization', async () => {
    const { tools, api } = setup();
    expect(
      await executeTool(tools, 'submit_review', {
        comments: [finding, { ...finding, path: '/workspace/src/index.ts' }],
      })
    ).toMatchObject({ error: expect.stringContaining('Exact duplicate') });
    expect(api.requests).toEqual([]);
  });

  it('rejects a non-diff line and deletion-only targets instead of fabricating anchors', async () => {
    const normal = setup();
    expect(
      await executeTool(normal.tools, 'submit_review', { comments: [{ ...finding, line: 100 }] })
    ).toMatchObject({ error: expect.stringContaining('RIGHT-side diff target') });
    expect(writes(normal.api)).toEqual([]);
    const removed = setup();
    removed.api.files = [diffFile({ status: 'removed' })];
    expect(await executeTool(removed.tools, 'submit_review', args)).toMatchObject({
      error: expect.stringContaining('summary-only'),
    });
    expect(writes(removed.api)).toEqual([]);
  });

  it('rejects a clipped or malformed patch as required missing evidence', async () => {
    const { tools, api, onContextIncomplete } = setup();
    api.files = [diffFile({ patch: '@@ -1,5 +1,6 @@\n one\n+partial' })];
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow('incomplete');
    expect(onContextIncomplete).toHaveBeenCalledOnce();
    expect(writes(api)).toEqual([]);
  });

  it('rejects an exact active body/path/line duplicate regardless of author', async () => {
    const { tools, api } = setup();
    api.inline = [inlineComment({ body: 'Issue', user: { login: 'a-human' } })];
    expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
      error: expect.stringContaining('exact active inline comment'),
    });
    expect(writes(api)).toEqual([]);
  });

  it('permits a distinct defect on the same RIGHT-side line', async () => {
    const { tools, api } = setup();
    api.inline = [inlineComment({ body: 'Unrelated distinct defect' })];
    expect(await executeTool(tools, 'submit_review', args)).toEqual({ id: 1_000 });
    expect(writes(api)).toHaveLength(1);
  });

  it.each([
    { in_reply_to_id: 99 },
    { line: null, original_line: 4, position: 3 },
    { subject_type: 'file', line: null },
    { side: 'LEFT' },
  ])(
    'does not use replies, original positions, file comments, or LEFT-side lines as root duplicate evidence',
    async override => {
      const { tools, api } = setup();
      api.inline = [inlineComment({ body: 'Issue', ...override })];
      expect(await executeTool(tools, 'submit_review', args)).toEqual({ id: 1_000 });
      expect(writes(api)).toHaveLength(1);
    }
  );

  it('preserves reply, file-comment, outdated, and original-position metadata without treating it as current proof', async () => {
    const { tools, api } = setup();
    api.inline = [
      inlineComment({ line: null, original_line: 4, position: 20 }),
      inlineComment({ id: 15, subject_type: 'file', line: null }),
      inlineComment({ id: 16, in_reply_to_id: 14 }),
    ];
    const result = await executeTool(tools, 'pr_comments', {});
    expect(result).toMatchObject({
      inlineComments: [
        expect.objectContaining({ id: 14, outdated: true, original_line: 4, position: 20 }),
        expect.objectContaining({ id: 15, subject_type: 'file' }),
      ],
      inlineReplies: [expect.objectContaining({ id: 16, isReply: true })],
      activeRootCount: 0,
    });
  });

  it.each(['submit_review', 'upsert_summary'] as const)(
    'checks open/non-draft eligibility for live and dry-run %s',
    async toolName => {
      for (const dryRun of [false, true]) {
        for (const metadata of [
          { state: 'closed', draft: false },
          { state: 'open', draft: true },
          { state: undefined, draft: false },
          { state: 'open', draft: undefined },
        ]) {
          const { tools, api, onProposal, onContextIncomplete } = setup({
            input: { ...input, dryRun },
          });
          Object.assign(api.pull, metadata);
          expect(
            await executeTool(
              tools,
              toolName,
              toolName === 'submit_review' ? args : { body: 'Summary' }
            )
          ).toMatchObject({
            publishable: false,
            blockedReason: expect.stringContaining('open and not a draft'),
          });
          expect(onProposal).toHaveBeenCalledWith(expect.objectContaining({ publishable: false }));
          expect(onContextIncomplete).not.toHaveBeenCalled();
          expect(writes(api)).toEqual([]);
        }
      }
    }
  );

  it('previews empty review envelopes and a marked summary with no dry-run mutations', async () => {
    const { tools, api, onPublicationStarted, onPublished, onProposal } = setup({
      input: { ...input, dryRun: true },
    });
    expect(
      await executeTool(tools, 'submit_review', { ...args, body: 'Accidental review narrative' })
    ).toMatchObject({
      dryRun: true,
      publishable: true,
      wouldSend: { commit_id: snapshot.headSha, event: 'COMMENT', body: '', comments: [finding] },
    });
    expect(await executeTool(tools, 'upsert_summary', { body: 'Summary' })).toMatchObject({
      dryRun: true,
      publishable: true,
      wouldSend: {
        method: 'POST',
        path: `${issuePath}/comments`,
        payload: {
          body: `<!-- kilo-review -->\nSummary\n<!-- kilo-isolate-review-summary:${await hash(runId)} -->`,
        },
      },
    });
    expect(api.requests.length).toBeGreaterThan(0);
    expect(writes(api)).toEqual([]);
    expect(onProposal).toHaveBeenCalledTimes(2);
    expect(onPublicationStarted).not.toHaveBeenCalled();
    expect(onPublished).not.toHaveBeenCalled();
  });

  it('still checks dry-run snapshots when supplied historical publication flags', async () => {
    const { tools, api } = setup({
      input: { ...input, dryRun: true },
      publicationState: { reviewId: 12, summaryPublished: true, summaryCommentId: 13 },
    });
    api.pull.head = { sha: 'e'.repeat(40) };
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow('head changed');
    expect(writes(api)).toEqual([]);
  });

  it.each([kiloBotUser, { login: 'octocat' }, { login: 'kilo-code-evil[bot]' }])(
    'blocks unknown marked ownership before any inline POST, including same-bot production summaries',
    async user => {
      const { tools, api } = setup();
      api.issues = [issueComment({ body: oldSummary, user })];
      expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
        publishable: false,
        blockedReason: expect.stringContaining('ownership is unknown'),
      });
      expect(writes(api)).toEqual([]);
    }
  );

  it('does not treat an arbitrary caller summary ID as authority, even for a same-bot marker', async () => {
    const { tools, api } = setup({ input: { ...input, existingSummaryCommentId: 9 } });
    api.issues = [issueComment({ body: oldSummary, user: kiloBotUser })];
    expect(await executeTool(tools, 'upsert_summary', { body: 'Summary' })).toMatchObject({
      publishable: false,
    });
    expect(writes(api)).toEqual([]);
  });

  it('allows read-only analysis of an unknown summary but labels every dry-run proposal blocked', async () => {
    const { tools, api, onProposal, onContextIncomplete } = setup({
      input: { ...input, dryRun: true },
    });
    api.issues = [issueComment({ body: oldSummary, user: kiloBotUser })];
    expect(await executeTool(tools, 'pr_comments', {})).toMatchObject({
      summaries: [expect.objectContaining({ body: oldSummary })],
    });
    for (const [name, value] of [
      ['submit_review', args],
      ['upsert_summary', { body: 'Summary' }],
    ] as const) {
      expect(await executeTool(tools, name, value)).toMatchObject({
        dryRun: true,
        publishable: false,
        blockedReason: expect.stringContaining('ownership is unknown'),
      });
    }
    expect(onProposal.mock.calls.every(([event]) => !event.publishable)).toBe(true);
    expect(onContextIncomplete).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
  });

  it('publishes inline then PATCHes only a lifecycle-proven unchanged candidate summary', async () => {
    const { tools, api, onPublished, onPublicationStarted } = await ownedSetup();
    expect(await executeTool(tools, 'submit_review', args)).toEqual({ id: 1_000 });
    expect(await executeTool(tools, 'upsert_summary', { body: 'Summary' })).toEqual({ id: 9 });
    expect(writes(api).map(request => [request.init.method, request.url.pathname])).toEqual([
      ['POST', `${pullPath}/reviews`],
      ['PATCH', '/repos/acme/widget/issues/comments/9'],
    ]);
    const bodyHash = await hash('<!-- kilo-review -->\nSummary');
    expect(onPublicationStarted).toHaveBeenCalledWith('summary', {
      fingerprint: expect.any(String),
      bodyHash,
      commentId: 9,
    });
    expect(onPublished).toHaveBeenCalledWith({
      kind: 'summary',
      id: 9,
      fingerprint: expect.any(String),
      bodyHash,
    });
  });

  it.each([
    'kilocode[bot]',
    'KILO-CODE-REVIEW-BOT[BOT]',
    'kiloconnect[bot]',
    'kiloconnect-development[bot]',
    'kiloconnect-lite[bot]',
  ])('preserves bot recognition for %s while still requiring origin proof', async login => {
    const { tools, api } = await ownedSetup();
    api.issues[0].user = { login };
    api.issues[0].issue_url = 'https://api.github.com/repos/ACME/WIDGET/issues/42';
    expect(await executeTool(tools, 'upsert_summary', { body: 'Summary' })).toEqual({ id: 9 });
    expect(writes(api)[0]?.init.method).toBe('PATCH');
  });

  it('rejects same-bot edits without footer markers when the confirmed body hash changed', async () => {
    const { tools, api } = await ownedSetup();
    api.issues[0].body = '<!-- kilo-review -->\nsame bot edited this';
    expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
      publishable: false,
      blockedReason: expect.stringContaining('body changed'),
    });
    expect(writes(api)).toEqual([]);
  });

  it.each([
    ['kilo-review-history', summaryHistory],
    ['kilo-usage', `---\n${summaryUsage}`],
    ['kilo-review-guidance', `---\n${summaryGuidance}`],
  ])(
    'refuses backend-owned %s blocks even with a matching ownership hash',
    async (_marker, block) => {
      const body = `${oldSummary}\n\n${block}`;
      const { tools, api } = await ownedSetup(body);
      expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
        publishable: false,
        blockedReason: expect.stringContaining('server-owned'),
      });
      expect(await executeTool(tools, 'pr_comments', {})).toMatchObject({
        summaries: [expect.objectContaining({ body: oldSummary, serverOwnedBlocksExcluded: true })],
      });
      expect(await executeTool(tools, 'pr_comment', { category: 'issue', id: 9 })).toMatchObject({
        body: oldSummary,
        bodyHash: await hash(body),
        serverOwnedBlocksExcluded: true,
        originalLength: body.length,
      });
      expect(writes(api)).toEqual([]);
    }
  );

  it.each(['', '   ', '<!-- kilo-review -->', 'Summary\n<!-- kilo-usage -->\nmodel-owned footer'])(
    'rejects invalid or server-owned summary proposals',
    async body => {
      const { tools, api, onProposal } = setup();
      expect(await executeTool(tools, 'upsert_summary', { body })).toHaveProperty('error');
      expect(api.requests).toEqual([]);
      expect(onProposal).not.toHaveBeenCalled();
    }
  );

  it('rejects proof tied to another previous run or requested summary ID', async () => {
    for (const override of [{ previousRunId: 'other-run' }, { existingSummaryCommentId: 10 }]) {
      const { tools, api } = await ownedSetup(oldSummary, { input: { ...input, ...override } });
      expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
        publishable: false,
        blockedReason: expect.stringContaining('proof does not match'),
      });
      expect(writes(api)).toEqual([]);
    }
  });

  it('refuses a second marked summary even when the selected candidate target is owned', async () => {
    const { tools, api } = await ownedSetup();
    api.issues.push(
      issueComment({ id: 10, body: '<!-- kilo-review -->\nProduction', user: kiloBotUser })
    );
    expect(await executeTool(tools, 'submit_review', args)).toMatchObject({
      publishable: false,
      blockedReason: expect.stringContaining('Another marked summary'),
    });
    expect(writes(api)).toEqual([]);
  });

  it('does not silently replace a missing or untrusted candidate target with a new summary', async () => {
    for (const invalid of ['missing', 'human', 'marker', 'different-pr'] as const) {
      const { tools, api } = await ownedSetup();
      api.override = url => {
        if (!url.pathname.endsWith('/issues/comments/9')) return undefined;
        if (invalid === 'missing') return new Response(null, { status: 404 });
        return Response.json(
          issueComment({
            body: invalid === 'marker' ? 'unmarked' : oldSummary,
            user: invalid === 'human' ? { login: 'octocat' } : kiloBotUser,
            issue_url: `https://api.github.com/repos/acme/widget/issues/${invalid === 'different-pr' ? 41 : 42}`,
          })
        );
      };
      expect(await executeTool(tools, 'upsert_summary', { body: 'Summary' })).toMatchObject({
        publishable: false,
      });
      expect(writes(api)).toEqual([]);
    }
  });

  it('reports a late conflict after inline success as partial and never overwrites it', async () => {
    const { tools, api } = await ownedSetup();
    await executeTool(tools, 'submit_review', args);
    api.issues[0].body = `${oldSummary}\n<!-- kilo-usage -->\nserver footer`;
    expect(await executeTool(tools, 'upsert_summary', { body: 'Summary' })).toMatchObject({
      partial: true,
      publicationOutcome: 'partial',
      publishable: false,
    });
    expect(writes(api)).toHaveLength(1);
  });

  it('revalidates the selected target after the final awaited head read before PATCH', async () => {
    const { tools, api } = await ownedSetup();
    let issueScanSeen = false;
    api.override = url => {
      if (url.pathname === `${issuePath}/comments`) issueScanSeen = true;
      if (url.pathname === pullPath && issueScanSeen)
        api.issues[0].body = `${oldSummary}\n<!-- kilo-review-guidance -->\nnew guidance`;
      return undefined;
    };
    expect(await executeTool(tools, 'upsert_summary', { body: 'Summary' })).toMatchObject({
      publishable: false,
      blockedReason: expect.stringContaining('server-owned'),
    });
    expect(writes(api)).toEqual([]);
  });

  it('invalidates a push during issue pagination even when the only other restriction is summary ownership', async () => {
    const { tools, api, onProposal } = setup({ input: { ...input, dryRun: true } });
    api.issues = [issueComment({ body: oldSummary, user: kiloBotUser })];
    api.override = url => {
      if (url.pathname === `${issuePath}/comments`) api.pull.head = { sha: 'e'.repeat(40) };
      return undefined;
    };
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow('head changed');
    expect(onProposal).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
  });
});

describe('cancellation and authorization at the write boundary', () => {
  it.each(['submit_review', 'upsert_summary'] as const)(
    'does not POST after abort while a head read is pending for %s',
    async name => {
      const controller = new AbortController();
      const { tools, api, onPublicationStarted, onContextIncomplete } = setup();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      api.override = async url => {
        if (url.pathname === pullPath) {
          entered.resolve();
          await release.promise;
        }
        return undefined;
      };
      const pending = executeTool(
        tools,
        name,
        name === 'submit_review' ? args : { body: 'Summary' },
        controller.signal
      );
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await entered.promise;
      controller.abort();
      release.resolve();
      await assertion;
      expect(writes(api)).toEqual([]);
      expect(onPublicationStarted).not.toHaveBeenCalled();
      expect(onContextIncomplete).not.toHaveBeenCalled();
    }
  );

  it.each(['inline', 'issue'] as const)(
    'propagates abort during %s pagination and never posts',
    async category => {
      const controller = new AbortController();
      const { tools, api, onPublicationStarted } = setup();
      if (category === 'inline')
        api.inline = Array.from({ length: 250 }, (_, index) =>
          inlineComment({ id: index + 1, in_reply_to_id: 999 })
        );
      else api.issues = Array.from({ length: 250 }, (_, index) => issueComment({ id: index + 1 }));
      const endpoint = category === 'inline' ? `${pullPath}/comments` : `${issuePath}/comments`;
      api.override = (url, init) => {
        expect(init.signal).toBe(controller.signal);
        if (url.pathname === endpoint && url.searchParams.get('page') === '2') controller.abort();
        return undefined;
      };
      await expect(
        executeTool(tools, 'submit_review', args, controller.signal)
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(
        api.requests.some(
          request =>
            request.url.pathname === endpoint && request.url.searchParams.get('page') === '3'
        )
      ).toBe(false);
      expect(writes(api)).toEqual([]);
      expect(onPublicationStarted).not.toHaveBeenCalled();
    }
  );

  it('rechecks abort after all awaited preflight and proposal persistence work', async () => {
    const controller = new AbortController();
    const { tools, api, onPublicationStarted } = setup({
      onProposal: async () => {
        controller.abort();
      },
    });
    await expect(
      executeTool(tools, 'submit_review', args, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(writes(api)).toEqual([]);
    expect(onPublicationStarted).not.toHaveBeenCalled();
  });

  it('does not issue a write when the authorize-and-persist callback rejects', async () => {
    const { tools, api } = setup({
      onPublicationStarted: async () => {
        throw new Error('terminal run');
      },
    });
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow('terminal run');
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
      'publication is pending'
    );
    expect(writes(api)).toEqual([]);
  });

  it('checks abort again after the authorization callback returns', async () => {
    const controller = new AbortController();
    const { tools, api } = setup({
      onPublicationStarted: async () => {
        controller.abort();
      },
    });
    await expect(
      executeTool(tools, 'upsert_summary', { body: 'Summary' }, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(writes(api)).toEqual([]);
  });

  it('performs no awaited GitHub reads after publication authorization', async () => {
    let authorized = false;
    const { tools, api } = setup({
      onPublicationStarted: async () => {
        authorized = true;
      },
    });
    api.override = (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') expect(authorized).toBe(false);
      else expect(authorized).toBe(true);
      return undefined;
    };
    await executeTool(tools, 'submit_review', args);
    expect(writes(api)).toHaveLength(1);
  });

  it('keeps a concurrent different operation fenced while authorization is pending', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { tools, api } = setup({
      onPublicationStarted: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const pending = executeTool(tools, 'submit_review', args);
    await started.promise;
    expect(await executeTool(tools, 'upsert_summary', { body: 'Summary' })).toMatchObject({
      publicationOutcome: 'uncertain',
      publishable: false,
    });
    release.resolve();
    await pending;
    expect(writes(api)).toHaveLength(1);
  });

  it.each(['submit_review', 'upsert_summary'] as const)(
    'rechecks confirmed fingerprints after concurrent %s preflight',
    async name => {
      for (const conflicting of [false, true]) {
        const firstEntered = Promise.withResolvers<void>();
        const secondEntered = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        const releaseSecond = Promise.withResolvers<void>();
        let proposals = 0;
        const { tools, api } = setup({
          onProposal: async () => {
            if (++proposals === 1) {
              firstEntered.resolve();
              await releaseFirst.promise;
            } else {
              secondEntered.resolve();
              await releaseSecond.promise;
            }
          },
        });
        const value = name === 'submit_review' ? args : { body: 'Summary' };
        const other = !conflicting
          ? value
          : name === 'submit_review'
            ? { comments: [{ ...finding, body: 'Different issue' }] }
            : { body: 'Different summary' };
        const first = executeTool(tools, name, value);
        await firstEntered.promise;
        const second = executeTool(tools, name, other);
        const secondAssertion = conflicting
          ? expect(second).rejects.toThrow('conflicting')
          : expect(second).resolves.toEqual({ id: 1_000 });
        await secondEntered.promise;
        releaseFirst.resolve();
        await first;
        releaseSecond.resolve();
        await secondAssertion;
        expect(writes(api)).toHaveLength(1);
      }
    }
  );

  it('records an already-issued late acknowledgement without authorizing another write', async () => {
    const controller = new AbortController();
    const fixture = setup();
    const baseClient = createGithubClient('fixture-token', fixture.fetch);
    const post = vi.fn(async () => {
      controller.abort();
      return { id: 88 };
    });
    const tools = fixture.create({ client: { ...baseClient, post } as GithubClient });
    expect(await executeTool(tools, 'submit_review', args, controller.signal)).toEqual({ id: 88 });
    expect(fixture.onPublished).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'review', id: 88 })
    );
    await expect(
      executeTool(tools, 'upsert_summary', { body: 'Summary' }, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(post).toHaveBeenCalledOnce();
  });
});

describe('summary analysis content and publication hashes', () => {
  it.each([false, true])(
    'separates normalized analysis content from actual publication bytes with dryRun=%s',
    async dryRun => {
      const { tools, api, onProposal, onPublished } = setup({ input: { ...input, dryRun } });
      const body = 'A bounded summary\névidence';
      const normalized = `<!-- kilo-review -->\n${body}`;
      const result = await executeTool(tools, 'upsert_summary', {
        body: `${body}\n<!-- kilo-isolate-review-summary:caller-forgery -->`,
      });
      const event = onProposal.mock.calls[0]?.[0];
      if (!event) throw new Error('Missing summary proposal');
      const { kind, summaryContent, ...proposal } = event;
      expect(kind).toBe('summary');
      expect(summaryContent).toEqual({ body: normalized, bodyHash: await hash(normalized) });
      expect(ReviewProposalSchema.safeParse(proposal).success).toBe(true);
      expect(ReviewProposalSchema.safeParse({ ...proposal, summaryContent }).success).toBe(false);
      const sentBody = `${normalized}\n<!-- kilo-isolate-review-summary:${await hash(runId)} -->`;
      expect(event.bodyHash).toBe(await hash(sentBody));
      expect(event.bodyHash).not.toBe(summaryContent?.bodyHash);
      expect(event.fingerprint).toBe(
        await hash(
          JSON.stringify(['summary', snapshot.headSha, `${issuePath}/comments`, { body: sentBody }])
        )
      );
      if (dryRun) {
        expect(result).toMatchObject({
          bodyHash: event.bodyHash,
          wouldSend: { payload: { body: sentBody } },
        });
        expect(writes(api)).toEqual([]);
      } else {
        expect(writes(api)[0]?.body).toEqual({ body: sentBody });
        expect(onPublished).toHaveBeenCalledWith(
          expect.objectContaining({ bodyHash: event.bodyHash })
        );
      }
    }
  );

  it('keeps candidate-owned PATCH content and actual body hashes identical without granting authority from content', async () => {
    const { tools, api, onProposal } = await ownedSetup();
    await executeTool(tools, 'upsert_summary', { body: 'Updated summary' });
    const event = onProposal.mock.calls[0]?.[0];
    const normalized = '<!-- kilo-review -->\nUpdated summary';
    expect(event).toMatchObject({
      summaryContent: { body: normalized, bodyHash: await hash(normalized) },
      bodyHash: await hash(normalized),
    });
    expect(writes(api)[0]?.init.method).toBe('PATCH');
    expect(writes(api)[0]?.body).toEqual({ body: normalized });
  });

  it('retains valid read-only summary content even when publication ownership is blocked', async () => {
    const { tools, api, onProposal } = setup({ input: { ...input, dryRun: true } });
    api.issues.push(issueComment({ body: oldSummary, user: kiloBotUser }));
    expect(
      await executeTool(tools, 'upsert_summary', { body: 'Read-only analysis' })
    ).toMatchObject({ dryRun: true, publishable: false });
    expect(onProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'summary',
        publishable: false,
        summaryContent: {
          body: '<!-- kilo-review -->\nRead-only analysis',
          bodyHash: await hash('<!-- kilo-review -->\nRead-only analysis'),
        },
      })
    );
    expect(writes(api)).toEqual([]);
  });

  it.each([
    '',
    '<!-- kilo-review -->',
    '<!-- kilo-review-history -->forged history',
    'é'.repeat(32 * 1024),
  ])('does not persist invalid or over-budget summary content', async body => {
    const { tools, api, onProposal } = setup();
    expect(await executeTool(tools, 'upsert_summary', { body })).toHaveProperty('error');
    expect(onProposal).not.toHaveBeenCalled();
    expect(writes(api)).toEqual([]);
  });
});

describe('run-bound summary creation provenance', () => {
  it('does not claim a concurrent identical unmarked production summary after an ambiguous CREATE without side effects', async () => {
    const fixture = setup();
    fixture.api.override = (_url, init) => {
      if (init.method === 'POST') throw new Error('lost response without acceptance');
      return undefined;
    };
    await expect(
      executeTool(fixture.tools, 'upsert_summary', { body: 'No issues found' })
    ).rejects.toThrow('lost response');
    const fingerprint = fixture.onPublicationStarted.mock.calls[0]?.[1]?.fingerprint;
    fixture.api.issues.push(
      issueComment({ body: '<!-- kilo-review -->\nNo issues found', user: kiloBotUser })
    );
    const recreated = fixture.create({
      publicationState: { summaryPending: true, summaryPendingFingerprint: fingerprint },
    });
    await expect(
      executeTool(recreated, 'upsert_summary', { body: 'No issues found' })
    ).rejects.toThrow('no matching GitHub comment');
    expect(fixture.onPublished).not.toHaveBeenCalled();
    expect(writes(fixture.api)).toHaveLength(1);
  });

  it('makes the creation marker run-unique and includes it in the confirmed exact body hash', async () => {
    const first = setup();
    const second = setup({ runId: 'another-trusted-run' });
    const marker = `<!-- kilo-isolate-review-summary:${await hash(runId)} -->`;
    const expectedBody = `<!-- kilo-review -->\nSummary\n${marker}`;
    await executeTool(first.tools, 'upsert_summary', { body: 'Summary' });
    await executeTool(second.tools, 'upsert_summary', { body: 'Summary' });
    expect(first.api.issues[0]?.body).toBe(expectedBody);
    expect(second.api.issues[0]?.body).not.toBe(expectedBody);
    expect(first.onPublished).toHaveBeenCalledWith({
      kind: 'summary',
      id: 1_000,
      fingerprint: expect.any(String),
      bodyHash: await hash(expectedBody),
    });
    const event = first.onPublished.mock.calls[0]?.[0];
    const recreated = first.create({
      publicationState: {
        summaryPublished: true,
        summaryCommentId: event?.id,
        summaryFingerprint: event?.fingerprint,
        summaryBodyHash: event?.bodyHash,
      },
    });
    expect(await executeTool(recreated, 'upsert_summary', { body: expectedBody })).toEqual({
      id: 1_000,
    });
    expect(writes(first.api)).toHaveLength(1);
  });

  it('ignores model-supplied creation-marker claims and derives only the service run marker', async () => {
    const fixture = setup();
    const marker = `<!-- kilo-isolate-review-summary:${await hash(runId)} -->`;
    await executeTool(fixture.tools, 'upsert_summary', {
      body: '<!-- kilo-review -->\nSummary\n<!-- kilo-isolate-review-summary:claimed-origin -->',
    });
    expect(fixture.api.issues[0]?.body).toBe(`<!-- kilo-review -->\nSummary\n${marker}`);
    expect(
      await executeTool(fixture.tools, 'pr_comment', { category: 'issue', id: 1_000 })
    ).toMatchObject({ body: '<!-- kilo-review -->\nSummary', serverOwnedBlocksExcluded: true });
  });

  it('fails ambiguous standalone creation with unknown origin when no trusted run identity is supplied', async () => {
    const fixture = setup({ runId: undefined });
    fixture.api.loseWriteResponse = true;
    await expect(executeTool(fixture.tools, 'upsert_summary', { body: 'Summary' })).rejects.toThrow(
      'connection interrupted'
    );
    const before = fixture.api.requests.length;
    await expect(executeTool(fixture.tools, 'upsert_summary', { body: 'Summary' })).rejects.toThrow(
      'trusted run identity'
    );
    expect(fixture.api.requests).toHaveLength(before);
    expect(fixture.onPublished).not.toHaveBeenCalled();
    expect(writes(fixture.api)).toHaveLength(1);
  });

  it('does not use a matching operation marker alone as prior-summary mutation authority', async () => {
    const fixture = setup();
    const marker = `<!-- kilo-isolate-review-summary:${await hash(runId)} -->`;
    fixture.api.issues = [issueComment({ body: `${oldSummary}\n${marker}`, user: kiloBotUser })];
    expect(await executeTool(fixture.tools, 'submit_review', args)).toMatchObject({
      publishable: false,
      blockedReason: expect.stringContaining('ownership is unknown'),
    });
    expect(await executeTool(fixture.tools, 'upsert_summary', { body: 'Summary' })).toMatchObject({
      publishable: false,
    });
    expect(writes(fixture.api)).toEqual([]);
  });

  it('does not reconcile a creation under a different trusted run identity', async () => {
    const fixture = setup();
    fixture.api.loseWriteResponse = true;
    await expect(executeTool(fixture.tools, 'upsert_summary', { body: 'Summary' })).rejects.toThrow(
      'connection interrupted'
    );
    const fingerprint = fixture.onPublicationStarted.mock.calls[0]?.[1]?.fingerprint;
    const before = fixture.api.requests.length;
    const recreated = fixture.create({
      runId: 'different-run',
      publicationState: { summaryPending: true, summaryPendingFingerprint: fingerprint },
    });
    await expect(executeTool(recreated, 'upsert_summary', { body: 'Summary' })).rejects.toThrow(
      'fingerprint does not match'
    );
    expect(fixture.api.requests).toHaveLength(before);
    expect(fixture.onPublished).not.toHaveBeenCalled();
  });

  it.each(['edited-body', 'human', 'different-pr'] as const)(
    'does not accept a run marker with %s during CREATE reconciliation',
    async change => {
      const fixture = setup();
      fixture.api.loseWriteResponse = true;
      await expect(
        executeTool(fixture.tools, 'upsert_summary', { body: 'Summary' })
      ).rejects.toThrow('connection interrupted');
      const comment = fixture.api.issues[0];
      if (change === 'edited-body') comment.body = `Changed\n${comment.body as string}`;
      if (change === 'human') comment.user = { login: 'octocat' };
      if (change === 'different-pr')
        comment.issue_url = 'https://api.github.com/repos/acme/widget/issues/41';
      await expect(
        executeTool(fixture.tools, 'upsert_summary', { body: 'Summary' })
      ).rejects.toThrow('no matching GitHub comment');
      expect(fixture.onPublished).not.toHaveBeenCalled();
      expect(writes(fixture.api)).toHaveLength(1);
    }
  );

  it('requires an exact unchanged raw body hash before PATCHing a previously marked candidate summary', async () => {
    const previousMarker = `<!-- kilo-isolate-review-summary:${await hash('previous-candidate')} -->`;
    const previousBody = `${oldSummary}\n${previousMarker}`;
    const valid = await ownedSetup(previousBody);
    expect(
      await executeTool(valid.tools, 'pr_comment', { category: 'issue', id: 9 })
    ).toMatchObject({
      body: oldSummary,
      bodyHash: await hash(previousBody),
      serverOwnedBlocksExcluded: true,
    });
    expect(await executeTool(valid.tools, 'upsert_summary', { body: 'Summary' })).toEqual({
      id: 9,
    });
    expect(valid.api.issues[0]?.body).toBe('<!-- kilo-review -->\nSummary');
    expect(valid.onPublished).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9, bodyHash: await hash('<!-- kilo-review -->\nSummary') })
    );
    const edited = await ownedSetup(previousBody);
    edited.api.issues[0].body = oldSummary;
    expect(await executeTool(edited.tools, 'upsert_summary', { body: 'Summary' })).toMatchObject({
      publishable: false,
      blockedReason: expect.stringContaining('body changed'),
    });
    expect(writes(edited.api)).toEqual([]);
  });
});

describe('reconstructed publication fences', () => {
  it.each([false, true])(
    'keeps failed required context fenced after reconstruction with dryRun=%s',
    async dryRun => {
      const persisted: GithubPublicationState = {};
      const fixture = setup({
        publicationState: persisted,
        onContextIncomplete: async reason => {
          persisted.contextIncompleteReasons = [reason];
        },
      });
      fixture.api.pull.head = { sha: 'e'.repeat(40) };
      await expect(executeTool(fixture.tools, 'pr_view', {})).rejects.toThrow('head changed');
      fixture.api.pull.head = { sha: snapshot.headSha };
      const before = fixture.api.requests.length;
      for (const [name, value] of [
        ['submit_review', args],
        ['upsert_summary', { body: 'No issues' }],
      ] as const) {
        const recreated = fixture.create({ input: { ...input, dryRun } });
        expect(await executeTool(recreated, name, value)).toMatchObject({
          publishable: false,
          blockedReason: expect.stringContaining('head changed'),
        });
      }
      expect(fixture.api.requests).toHaveLength(before);
      expect(writes(fixture.api)).toEqual([]);
      expect(fixture.onProposal).not.toHaveBeenCalled();
      expect(fixture.onPublicationStarted).not.toHaveBeenCalled();
    }
  );

  it.each(['review', 'summary'] as const)(
    'preserves the separate %s reconciliation budget across reconstruction',
    async kind => {
      const persisted: GithubPublicationState =
        kind === 'review'
          ? { summaryReconciliationAttempts: 2 }
          : { reviewReconciliationAttempts: 2 };
      const countKey =
        kind === 'review' ? 'reviewReconciliationAttempts' : 'summaryReconciliationAttempts';
      const onReconciliationStarted = vi.fn(async (requested: 'review' | 'summary') => {
        expect(requested).toBe(kind);
        if ((persisted[countKey] ?? 0) >= 2)
          throw new Error('Durable reconciliation budget exhausted');
        persisted[countKey] = (persisted[countKey] ?? 0) + 1;
      });
      const fixture = setup({
        publicationState: persisted,
        onReconciliationStarted,
        onPublicationStarted: async (requested, details) => {
          if (requested === 'review') {
            persisted.reviewPending = true;
            persisted.reviewPendingFingerprint = details?.fingerprint;
          } else {
            persisted.summaryPending = true;
            persisted.summaryPendingFingerprint = details?.fingerprint;
          }
        },
      });
      fixture.api.override = (_url, init) => {
        if (init.method === 'POST') throw new Error('ambiguous fixture write');
        return undefined;
      };
      const name = kind === 'review' ? 'submit_review' : 'upsert_summary';
      const value = kind === 'review' ? args : { body: 'Summary' };
      await expect(executeTool(fixture.tools, name, value)).rejects.toThrow(
        'ambiguous fixture write'
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(executeTool(fixture.create(), name, value)).rejects.toThrow(
          'no matching GitHub'
        );
      }
      const before = fixture.api.requests.length;
      await expect(executeTool(fixture.create(), name, value)).rejects.toThrow(
        'reconciliation budget exhausted'
      );
      expect(persisted[countKey]).toBe(2);
      expect(onReconciliationStarted).toHaveBeenCalledTimes(2);
      expect(fixture.api.requests).toHaveLength(before);
      expect(writes(fixture.api)).toHaveLength(1);
      expect(fixture.onPublished).not.toHaveBeenCalled();
    }
  );

  it.each(['review', 'summary'] as const)(
    'does not read or repost when the %s reconciliation reservation fails',
    async kind => {
      const onReconciliationStarted = vi.fn(async () => {
        throw new Error('reservation storage failed');
      });
      const fixture = setup({ onReconciliationStarted });
      fixture.api.loseWriteResponse = true;
      const name = kind === 'review' ? 'submit_review' : 'upsert_summary';
      const value = kind === 'review' ? args : { body: 'Summary' };
      await expect(executeTool(fixture.tools, name, value)).rejects.toThrow(
        'connection interrupted'
      );
      const before = fixture.api.requests.length;
      await expect(executeTool(fixture.tools, name, value)).rejects.toThrow(
        'reservation storage failed'
      );
      expect(fixture.api.requests).toHaveLength(before);
      expect(writes(fixture.api)).toHaveLength(1);
      expect(fixture.onPublished).not.toHaveBeenCalled();
      expect(onReconciliationStarted).toHaveBeenCalledWith(kind);
    }
  );

  it('rechecks abort after the persisted reconciliation reservation', async () => {
    const controller = new AbortController();
    const fixture = setup({
      onReconciliationStarted: async () => {
        controller.abort();
      },
    });
    fixture.api.loseWriteResponse = true;
    await expect(executeTool(fixture.tools, 'submit_review', args)).rejects.toThrow(
      'connection interrupted'
    );
    const before = fixture.api.requests.length;
    await expect(
      executeTool(fixture.tools, 'submit_review', args, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fixture.api.requests).toHaveLength(before);
    expect(fixture.onPublished).not.toHaveBeenCalled();
  });
});

describe('publication fingerprints, rejected outcomes, and read-only reconciliation', () => {
  it('preserves successful review fingerprints for identical replay and conflicting-operation refusal', async () => {
    const { tools, api, create, onPublished } = setup();
    await executeTool(tools, 'submit_review', { ...args, body: 'Ignored review narrative' });
    const count = api.requests.length;
    expect(
      await executeTool(tools, 'submit_review', { ...args, body: 'Different ignored narrative' })
    ).toEqual({ id: 1_000 });
    await expect(
      executeTool(tools, 'submit_review', { comments: [{ ...finding, body: 'Different finding' }] })
    ).rejects.toThrow('conflicting');
    const event = onPublished.mock.calls[0]?.[0];
    const recreated = create({
      publicationState: { reviewId: event?.id, reviewFingerprint: event?.fingerprint },
    });
    expect(await executeTool(recreated, 'submit_review', args)).toEqual({ id: 1_000 });
    expect(api.requests).toHaveLength(count);
    expect(writes(api)).toHaveLength(1);
  });

  it('keeps the first logical summary idempotent rather than PATCHing it on replay or conflicting input', async () => {
    const { tools, api, create, onPublished } = setup();
    expect(await executeTool(tools, 'upsert_summary', { body: 'Summary' })).toEqual({ id: 1_000 });
    const count = api.requests.length;
    expect(
      await executeTool(tools, 'upsert_summary', { body: '<!-- kilo-review -->\nSummary' })
    ).toEqual({ id: 1_000 });
    await expect(
      executeTool(tools, 'upsert_summary', { body: 'Different summary' })
    ).rejects.toThrow('conflicting');
    const event = onPublished.mock.calls[0]?.[0];
    const recreated = create({
      publicationState: {
        summaryPublished: true,
        summaryCommentId: event?.id,
        summaryFingerprint: event?.fingerprint,
        summaryBodyHash: event?.bodyHash,
      },
    });
    expect(await executeTool(recreated, 'upsert_summary', { body: 'Summary' })).toEqual({
      id: 1_000,
    });
    expect(api.requests).toHaveLength(count);
    expect(writes(api)).toHaveLength(1);
  });

  it('refuses legacy successful IDs without a proven operation fingerprint or summary body hash', async () => {
    const reviewFixture = setup({ publicationState: { reviewId: 81 } });
    await expect(executeTool(reviewFixture.tools, 'submit_review', args)).rejects.toThrow(
      'unproven'
    );
    expect(reviewFixture.api.requests).toEqual([]);
    const summaryFixture = setup({
      publicationState: { summaryCommentId: 9, summaryPublished: true },
    });
    await expect(
      executeTool(summaryFixture.tools, 'upsert_summary', { body: 'Summary' })
    ).rejects.toThrow('unproven');
    expect(summaryFixture.api.requests).toEqual([]);
  });

  it('fails closed for a persisted nonempty-body fingerprint before any GitHub request', async () => {
    const legacy = await hash(
      JSON.stringify([
        'review',
        snapshot.headSha,
        `${pullPath}/reviews`,
        {
          commit_id: snapshot.headSha,
          event: 'COMMENT',
          body: 'Legacy review body',
          comments: [finding],
        },
      ])
    );
    const { tools, api } = setup({
      publicationState: { reviewPending: true, reviewPendingFingerprint: legacy },
    });
    await expect(
      executeTool(tools, 'submit_review', { ...args, body: 'Legacy review body' })
    ).rejects.toThrow('fingerprint does not match');
    expect(api.requests).toEqual([]);
  });

  it('canonicalizes fingerprints without reordering submitted inline comments', async () => {
    const { tools, api } = setup();
    api.files.push(diffFile({ filename: 'src/other.ts' }));
    const second = { ...finding, path: 'src/other.ts', line: 5, body: 'Second issue' };
    await executeTool(tools, 'submit_review', { comments: [second, finding] });
    expect(writes(api)[0]?.body).toMatchObject({ comments: [second, finding] });
    expect(
      await executeTool(tools, 'submit_review', { comments: [finding, second], body: 'Ignored' })
    ).toEqual({ id: 1_000 });
    expect(writes(api)).toHaveLength(1);
  });

  it('recovers an externally accepted empty-body review after transport loss and tool recreation without reposting', async () => {
    const fixture = setup();
    fixture.api.loseWriteResponse = true;
    await expect(
      executeTool(fixture.tools, 'submit_review', { ...args, body: 'Ignored review text' })
    ).rejects.toThrow('connection interrupted');
    expect(fixture.api.reviews[0]?.body).toBe('');
    const details = fixture.onPublicationStarted.mock.calls[0]?.[1];
    const recreated = fixture.create({
      publicationState: { reviewPending: true, reviewPendingFingerprint: details?.fingerprint },
    });
    const readsBeforeMismatch = fixture.api.requests.length;
    await expect(
      executeTool(recreated, 'submit_review', {
        comments: [{ ...finding, body: 'Different issue' }],
      })
    ).rejects.toThrow('fingerprint does not match');
    expect(fixture.api.requests).toHaveLength(readsBeforeMismatch);
    expect(
      await executeTool(recreated, 'submit_review', {
        ...args,
        body: 'Different ignored review text',
      })
    ).toEqual({ id: 1_000 });
    expect(fixture.onPublished).toHaveBeenCalledWith({
      kind: 'review',
      id: 1_000,
      fingerprint: details?.fingerprint,
    });
    expect(writes(fixture.api)).toHaveLength(1);
    expect(fixture.onPublicationRejected).not.toHaveBeenCalled();
    expect(fixture.onContextIncomplete).not.toHaveBeenCalled();
  });

  it.each([
    { body: 'Different body' },
    { commit_id: 'e'.repeat(40) },
    { state: 'PENDING' },
    { user: { login: 'octocat' } },
    { user: { login: 'kilo-code-evil[bot]' } },
  ])('does not recover a review from mismatching head, body, state, or author', async override => {
    const { tools, api, onPublished } = setup();
    api.loseWriteResponse = true;
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
      'connection interrupted'
    );
    Object.assign(api.reviews[0], override);
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
      'no matching GitHub review'
    );
    expect(onPublished).not.toHaveBeenCalled();
    expect(writes(api)).toHaveLength(1);
  });

  it.each([{ path: 'src/other.ts' }, { line: 5 }, { side: 'LEFT' }, { body: 'Different' }])(
    'does not recover a review when any published inline field differs',
    async override => {
      const { tools, api, onPublished } = setup();
      api.loseWriteResponse = true;
      await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
        'connection interrupted'
      );
      const comments = api.reviewComments.get(1_000);
      if (!comments) throw new Error('Missing fixture review');
      Object.assign(comments[0], override);
      await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
        'no matching GitHub review'
      );
      expect(onPublished).not.toHaveBeenCalled();
      expect(writes(api)).toHaveLength(1);
    }
  );

  it('does not recover multiple equally matching reviews', async () => {
    const { tools, api } = setup();
    api.loseWriteResponse = true;
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
      'connection interrupted'
    );
    api.reviews.push(review({ id: 2_000 }));
    api.reviewComments.set(2_000, api.reviewComments.get(1_000) ?? []);
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
      'multiple matching GitHub reviews'
    );
    expect(writes(api)).toHaveLength(1);
  });

  it('does not authorize a summary while an inline POST remains ambiguous', async () => {
    const { tools, api, onPublished } = setup();
    api.override = (_url, init) => {
      if (init.method === 'POST') throw new Error('connection interrupted');
      return undefined;
    };
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
      'connection interrupted'
    );
    expect(await executeTool(tools, 'upsert_summary', { body: 'Summary' })).toMatchObject({
      publishable: false,
      publicationOutcome: 'uncertain',
    });
    for (let attempt = 0; attempt < MAX_PUBLICATION_ATTEMPTS; attempt++) {
      await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
        'no matching GitHub review'
      );
    }
    const count = api.requests.length;
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
      'reconciliation budget exhausted'
    );
    expect(api.requests).toHaveLength(count);
    expect(onPublished).not.toHaveBeenCalled();
    expect(writes(api)).toHaveLength(1);
  });

  it.each(['create', 'patch'] as const)(
    'recovers an accepted summary %s after transport loss without a duplicate write',
    async mode => {
      const fixture = mode === 'patch' ? await ownedSetup() : setup();
      fixture.api.loseWriteResponse = true;
      await expect(
        executeTool(fixture.tools, 'upsert_summary', { body: 'Summary' })
      ).rejects.toThrow('connection interrupted');
      const details = fixture.onPublicationStarted.mock.calls[0]?.[1];
      const recreated = fixture.create({
        publicationState: {
          summaryPending: true,
          summaryPendingFingerprint: details?.fingerprint,
          summaryPendingCommentId: details?.commentId,
        },
      });
      const readsBeforeMismatch = fixture.api.requests.length;
      await expect(executeTool(recreated, 'upsert_summary', { body: 'Different' })).rejects.toThrow(
        'fingerprint does not match'
      );
      expect(fixture.api.requests).toHaveLength(readsBeforeMismatch);
      expect(await executeTool(recreated, 'upsert_summary', { body: 'Summary' })).toEqual({
        id: mode === 'patch' ? 9 : 1_000,
      });
      expect(fixture.onPublished).toHaveBeenCalledWith({
        kind: 'summary',
        id: mode === 'patch' ? 9 : 1_000,
        fingerprint: details?.fingerprint,
        bodyHash: await hash(fixture.api.issues[0]?.body as string),
      });
      expect(writes(fixture.api)).toHaveLength(1);
    }
  );

  it('does not recover a summary from a human, changed body, or different PR', async () => {
    for (const override of [
      { user: { login: 'octocat' } },
      { body: oldSummary },
      { issue_url: 'https://api.github.com/repos/acme/widget/issues/41' },
    ]) {
      const { tools, api, onPublished } = await ownedSetup();
      api.loseWriteResponse = true;
      await expect(executeTool(tools, 'upsert_summary', { body: 'Summary' })).rejects.toThrow(
        'connection interrupted'
      );
      Object.assign(api.issues[0], override);
      await expect(executeTool(tools, 'upsert_summary', { body: 'Summary' })).rejects.toThrow(
        'no matching GitHub comment'
      );
      expect(onPublished).not.toHaveBeenCalled();
      expect(writes(api)).toHaveLength(1);
    }
  });

  it('does not recover multiple equally matching summaries', async () => {
    const { tools, api } = setup();
    api.loseWriteResponse = true;
    await expect(executeTool(tools, 'upsert_summary', { body: 'Summary' })).rejects.toThrow(
      'connection interrupted'
    );
    api.issues.push(issueComment({ id: 2_000, body: api.issues[0]?.body, user: kiloBotUser }));
    await expect(executeTool(tools, 'upsert_summary', { body: 'Summary' })).rejects.toThrow(
      'multiple matching GitHub comments'
    );
    expect(writes(api)).toHaveLength(1);
  });

  it('refuses pending summary recovery against a changed persisted target', async () => {
    const { tools, api } = setup({
      publicationState: {
        summaryPending: true,
        summaryPendingCommentId: 9,
        summaryCommentId: 10,
        summaryPendingFingerprint: '0'.repeat(64),
      },
    });
    await expect(executeTool(tools, 'upsert_summary', { body: 'Summary' })).rejects.toThrow(
      'fingerprint does not match'
    );
    expect(api.requests).toEqual([]);
  });

  it.each(['review', 'summary', 'patch'] as const)(
    'allows at most one explicitly revalidated retry after a 422 %s rejection',
    async kind => {
      const fixture = kind === 'patch' ? await ownedSetup() : setup();
      fixture.api.override = (_url, init) =>
        ['POST', 'PATCH'].includes(init.method ?? 'GET')
          ? Response.json({ message: 'invalid target' }, { status: 422 })
          : undefined;
      const name = kind === 'review' ? 'submit_review' : 'upsert_summary';
      const value = kind === 'review' ? args : { body: 'Summary' };
      for (let attempt = 0; attempt < MAX_PUBLICATION_ATTEMPTS; attempt++) {
        expect(await executeTool(fixture.tools, name, value)).toMatchObject({
          status: 422,
          publicationOutcome: 'rejected',
        });
      }
      await expect(executeTool(fixture.tools, name, value)).rejects.toThrow(
        'retry budget exhausted'
      );
      expect(writes(fixture.api)).toHaveLength(MAX_PUBLICATION_ATTEMPTS);
      expect(fixture.onPublicationRejected).toHaveBeenCalledTimes(MAX_PUBLICATION_ATTEMPTS);
      expect(fixture.onPublished).not.toHaveBeenCalled();
      expect(fixture.onContextIncomplete).not.toHaveBeenCalled();
    }
  );

  it('rechecks target evidence before a corrected 422 retry and retains empty-body fingerprint parity', async () => {
    const { tools, api, onPublicationStarted } = setup();
    let reject = true;
    api.override = (_url, init) =>
      init.method === 'POST' && reject ? new Response('invalid line', { status: 422 }) : undefined;
    expect(
      await executeTool(tools, 'submit_review', { ...args, body: 'Ignored text' })
    ).toMatchObject({ status: 422 });
    reject = false;
    expect(
      await executeTool(tools, 'submit_review', {
        comments: [{ ...finding, path: '/workspace/src/index.ts' }],
        body: 'Different ignored text',
      })
    ).toEqual({ id: 1_000 });
    expect(onPublicationStarted.mock.calls[0]?.[1]?.fingerprint).toBe(
      onPublicationStarted.mock.calls[1]?.[1]?.fingerprint
    );
    expect(writes(api)).toHaveLength(2);
  });

  it('retries rejection persistence before corrected input, but fails closed after a restart with uncleared pending state', async () => {
    const onPublicationRejected = vi
      .fn()
      .mockRejectedValueOnce(new Error('rejection storage failed'))
      .mockResolvedValue(undefined);
    const fixture = setup({ onPublicationRejected });
    let reject = true;
    fixture.api.override = (_url, init) =>
      init.method === 'POST' && reject ? new Response('invalid line', { status: 422 }) : undefined;
    await expect(executeTool(fixture.tools, 'submit_review', args)).rejects.toThrow(
      'rejection storage failed'
    );
    const details = fixture.onPublicationStarted.mock.calls[0]?.[1];
    const recreated = fixture.create({
      publicationState: { reviewPending: true, reviewPendingFingerprint: details?.fingerprint },
    });
    await expect(
      executeTool(recreated, 'submit_review', { comments: [{ ...finding, line: 5 }] })
    ).rejects.toThrow('fingerprint does not match');
    reject = false;
    expect(
      await executeTool(fixture.tools, 'submit_review', { comments: [{ ...finding, line: 5 }] })
    ).toEqual({ id: 1_000 });
    expect(onPublicationRejected).toHaveBeenCalledTimes(2);
    expect(writes(fixture.api)).toHaveLength(2);
  });

  it.each(['submit_review', 'upsert_summary'] as const)(
    'retries publication persistence for %s without repeating a successful write',
    async name => {
      const onPublished = vi
        .fn()
        .mockRejectedValueOnce(new Error('storage failed'))
        .mockResolvedValue(undefined);
      const { tools, api, onContextIncomplete } = setup({ onPublished });
      const value = name === 'submit_review' ? args : { body: 'Summary' };
      await expect(executeTool(tools, name, value)).rejects.toThrow('storage failed');
      expect(await executeTool(tools, name, value)).toEqual({ id: 1_000 });
      expect(writes(api)).toHaveLength(1);
      expect(onPublished).toHaveBeenCalledTimes(2);
      expect(onContextIncomplete).not.toHaveBeenCalled();
    }
  );

  it('treats an acknowledged response with a malformed ID as ambiguous, never as permission to repost', async () => {
    const { tools, api, onPublished } = setup();
    api.override = (_url, init) =>
      init.method === 'POST' ? Response.json({ id: 'bad-id' }) : undefined;
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
      'review publication ID'
    );
    await expect(executeTool(tools, 'submit_review', args)).rejects.toThrow(
      'no matching GitHub review'
    );
    expect(writes(api)).toHaveLength(1);
    expect(onPublished).not.toHaveBeenCalled();
  });

  it('preserves existing zero-argument publication callbacks', async () => {
    const callback = vi.fn(async () => {});
    const { tools, api } = setup({ onPublished: callback });
    await executeTool(tools, 'submit_review', args);
    expect(callback).toHaveBeenCalledOnce();
    expect(writes(api)).toHaveLength(1);
  });
});
