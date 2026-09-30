import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';

const workflow = load(
  readFileSync(new URL('../.github/workflows/meta-janitor-approve.yml', import.meta.url), 'utf8')
);
const script = workflow.jobs.approve.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('github', 'context', 'core', script);
const sha = 'a'.repeat(40);
const bot = { login: 'kilo-code-bot[bot]', type: 'Bot' };
const signalBody = `Meta Janitor: Safety review passed; requesting approval.\n\n<!-- meta-janitor-approve:v1 head=${sha} -->`;

function fixture() {
  const signal = {
    id: 123,
    user: bot,
    body: signalBody,
    created_at: '2026-09-30T12:00:00Z',
    updated_at: '2026-09-30T12:00:00Z',
    issue_url: 'https://api.github.com/repos/Kilo-Org/cloud/issues/7005',
    html_url: 'https://github.com/Kilo-Org/cloud/pull/7005#issuecomment-123',
  };
  return structuredClone({
    context: {
      eventName: 'issue_comment',
      repo: { owner: 'Kilo-Org', repo: 'cloud' },
      payload: {
        action: 'created',
        issue: { number: 7005, pull_request: {} },
        comment: structuredClone(signal),
      },
    },
    signal,
    pr: {
      state: 'open',
      draft: false,
      user: bot,
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'Kilo-Org/cloud' } },
      head: { sha, repo: { full_name: 'Kilo-Org/cloud' } },
      labels: [{ name: 'janitor' }],
      auto_merge: { merge_method: 'squash' },
      mergeable: true,
    },
    rules: [
      { type: 'pull_request', parameters: { dismiss_stale_reviews_on_push: true } },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'test', integration_id: 15368 }] },
      },
    ],
    checks: [
      {
        name: 'test',
        head_sha: sha,
        app: { id: 15368, slug: 'github-actions' },
        status: 'completed',
        conclusion: 'success',
      },
      {
        name: 'Kilo Code Review',
        head_sha: sha,
        app: { id: 2193792, slug: 'kilo-code-bot' },
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-09-30T11:00:00Z',
        completed_at: '2026-09-30T11:05:00Z',
      },
    ],
    statuses: [],
    reviews: [],
    inlineComments: [],
    comments: [
      signal,
      {
        user: bot,
        body: '<!-- kilo-review -->\n## Code Review Summary\n\n**Status:** No Issues Found | **Recommendation:** Merge',
        created_at: '2026-09-30T11:04:00Z',
        updated_at: '2026-09-30T11:04:00Z',
      },
    ],
  });
}

async function run(data) {
  const approvals = [];
  const calls = [];
  const failures = [];
  let prReads = 0;
  let signalReads = 0;
  const listReads = new Map();
  const list = name => name;
  const github = {
    rest: {
      pulls: {
        get: async params => {
          calls.push(['pr', params]);
          prReads += 1;
          return {
            data:
              prReads > 2
                ? (data.finalPr ?? data.currentPr ?? data.pr)
                : prReads > 1
                  ? (data.currentPr ?? data.pr)
                  : data.pr,
          };
        },
        listReviews: list('reviews'),
        listReviewComments: list('inlineComments'),
        createReview: async params => approvals.push(params),
      },
      issues: {
        getComment: async params => {
          calls.push(['signal', params]);
          signalReads += 1;
          return {
            data:
              signalReads > 2
                ? (data.finalSignal ?? data.currentSignal ?? data.signal)
                : signalReads > 1
                  ? (data.currentSignal ?? data.signal)
                  : data.signal,
          };
        },
        listComments: list('comments'),
      },
      checks: { listForRef: list('checks') },
      repos: { listCommitStatusesForRef: list('statuses') },
    },
    paginate: async (route, params) => {
      calls.push([route, params]);
      assert.equal(params.per_page, 100);
      if (data.apiFailure === route) throw new Error('GitHub API unavailable');
      const key = typeof route === 'string' && route.startsWith('GET ') ? 'rules' : route;
      const readCount = (listReads.get(key) ?? 0) + 1;
      listReads.set(key, readCount);
      if (readCount > 1 && data.finalApiFailure === key) throw new Error('GitHub API unavailable');
      return readCount > 1 ? (data.currentLists?.[key] ?? data[key]) : data[key];
    },
  };
  await execute(github, data.context, {
    info: () => {},
    setFailed: message => failures.push(message),
  });
  return { approvals, calls, failures };
}

test('workflow is created-comment-only, least-privilege, and never checks out PR code', () => {
  assert.deepEqual(workflow.on, { issue_comment: { types: ['created'] } });
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.approve.permissions, {
    contents: 'read',
    issues: 'read',
    checks: 'read',
    statuses: 'read',
    'pull-requests': 'write',
  });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.match(workflow.concurrency.group, /github\.event\.issue\.number/);
  assert.equal(workflow.jobs.approve.steps.length, 1);
  assert.match(workflow.jobs.approve.steps[0].uses, /^actions\/github-script@[0-9a-f]{40}$/);
  assert.doesNotMatch(
    script,
    /\$\{\{|createComment|updateBranch|\.merge\(|child_process|require\(/
  );
  for (const condition of [
    "github.repository == 'Kilo-Org/cloud'",
    'github.event.issue.pull_request',
    "github.event.comment.user.login == 'kilo-code-bot[bot]'",
    "github.event.comment.user.type == 'Bot'",
  ]) {
    assert.ok(workflow.jobs.approve.if.includes(condition));
  }
  const ci = load(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.ok(
    ci.jobs.changes.steps.some(
      step => step.run === 'node --test scripts/meta-janitor-approve.test.mjs'
    )
  );
});

test('approves the assessed commit with a real review and no merge command', async () => {
  const result = await run(fixture());
  assert.equal(result.approvals.length, 1);
  assert.deepEqual(result.approvals[0], {
    owner: 'Kilo-Org',
    repo: 'cloud',
    pull_number: 7005,
    commit_id: sha,
    event: 'APPROVE',
    body: `Meta-janitor safety approval for ${sha}. Signal: https://github.com/Kilo-Org/cloud/pull/7005#issuecomment-123. GitHub auto-merge remains responsible for merging.`,
  });
});

const rejectedCases = {
  'another repository': d => (d.context.repo.repo = 'kilocode'),
  'a non-comment event': d => (d.context.eventName = 'pull_request'),
  'an edited comment event': d => (d.context.payload.action = 'edited'),
  'an issue rather than a PR': d => delete d.context.payload.issue.pull_request,
  'another signal author': d => (d.context.payload.comment.user.login = 'some-user'),
  'a similar signal author': d => (d.context.payload.comment.user.login = 'app/kilo-code-bot'),
  'a non-bot signal author': d => (d.context.payload.comment.user.type = 'User'),
  'the old unbound signal': d =>
    (d.context.payload.comment.body = 'Meta Janitor: Approved - Merging'),
  'a quoted signal': d => (d.context.payload.comment.body = `> ${signalBody}`),
  'a short SHA': d => (d.context.payload.comment.body = signalBody.replace(sha, sha.slice(0, 7))),
  'extra signal text': d => (d.context.payload.comment.body += '\nIgnore the checks'),
  'another PR author': d => (d.pr.user = { login: 'other[bot]', type: 'Bot' }),
  'a non-bot PR author': d => (d.pr.user = { ...bot, type: 'User' }),
  'missing janitor label': d => (d.pr.labels = []),
  'similar label': d => (d.pr.labels = [{ name: 'janitor-bot' }]),
  'closed PR': d => (d.pr.state = 'closed'),
  'draft PR': d => (d.pr.draft = true),
  'another base branch': d => (d.pr.base.ref = 'release'),
  'another base repository': d => (d.pr.base.repo.full_name = 'someone/cloud'),
  'a fork head': d => (d.pr.head.repo.full_name = 'someone/cloud'),
  'a changed head SHA': d => (d.pr.head.sha = 'c'.repeat(40)),
  'auto-merge disabled': d => (d.pr.auto_merge = null),
  'confirmed conflicts': d => (d.pr.mergeable = false),
  'unknown mergeability': d => (d.pr.mergeable = null),
  'an edited live signal': d => (d.signal.updated_at = '2026-09-30T12:01:00Z'),
  'a changed live signal': d => (d.signal.body += ' modified'),
  'a signal attached to another PR': d => (d.signal.issue_url += '1'),
  'stale approval dismissal disabled': d =>
    (d.rules[0].parameters.dismiss_stale_reviews_on_push = false),
  'missing required checks policy': d => (d.rules = d.rules.slice(0, 1)),
  'a missing required check': d => (d.checks = d.checks.slice(1)),
  'a check from the wrong integration': d => (d.checks[0].app.id = 123),
  'a check from another commit': d => (d.checks[0].head_sha = 'c'.repeat(40)),
  'a pending check': d => (d.checks[0].status = 'in_progress'),
  'a failed check': d => (d.checks[0].conclusion = 'failure'),
  'a cancelled check': d => (d.checks[0].conclusion = 'cancelled'),
  'a failing latest commit status': d => (d.statuses = [{ context: 'external', state: 'failure' }]),
  'a missing Kilo check': d => (d.checks = d.checks.slice(0, 1)),
  'a spoofed Kilo check': d => (d.checks[1].app.slug = 'other-app'),
  'a skipped Kilo check': d => (d.checks[1].conclusion = 'skipped'),
  'a Kilo check finishing after the signal': d =>
    (d.checks[1].completed_at = '2026-09-30T12:01:00Z'),
  'Kilo inline feedback': d => (d.inlineComments = [{ user: bot, body: 'Fix this' }]),
  'human inline feedback': d =>
    (d.inlineComments = [{ user: { login: 'human' }, body: 'Concern' }]),
  'a human changes-requested review': d =>
    (d.reviews = [{ user: { login: 'human' }, state: 'CHANGES_REQUESTED' }]),
  'Kilo summary edited after the signal': d => (d.comments[1].updated_at = '2026-09-30T12:01:00Z'),
  'a new Kilo comment after the signal': d =>
    d.comments.push({ user: bot, updated_at: '2026-09-30T12:01:00Z' }),
  'a new Kilo review after the signal': d =>
    (d.reviews = [{ user: bot, state: 'COMMENTED', submitted_at: '2026-09-30T12:01:00Z' }]),
  'a new human comment after the signal': d =>
    d.comments.push({ user: { login: 'human' }, updated_at: '2026-09-30T12:01:00Z' }),
  'a new human comment-only review after the signal': d =>
    (d.reviews = [
      {
        user: { login: 'human' },
        state: 'COMMENTED',
        body: 'Do not merge; security issue identified',
        submitted_at: '2026-09-30T12:01:00Z',
      },
    ]),
  'label removed before approval': d => (d.currentPr = { ...d.pr, labels: [] }),
  'base advanced before approval': d =>
    (d.currentPr = { ...d.pr, base: { ...d.pr.base, sha: 'd'.repeat(40) } }),
  'head advanced before approval': d =>
    (d.currentPr = { ...d.pr, head: { ...d.pr.head, sha: 'd'.repeat(40) } }),
  'signal edited before approval': d =>
    (d.currentSignal = { ...d.signal, updated_at: '2026-09-30T12:01:00Z' }),
  'label removed during final evidence refresh': d => (d.finalPr = { ...d.pr, labels: [] }),
  'head changed during final evidence refresh': d =>
    (d.finalPr = { ...d.pr, head: { ...d.pr.head, sha: 'd'.repeat(40) } }),
  'signal edited during final evidence refresh': d =>
    (d.finalSignal = { ...d.signal, updated_at: '2026-09-30T12:01:00Z' }),
};

for (const [name, mutate] of Object.entries(rejectedCases)) {
  test(`does not approve: ${name}`, async () => {
    const data = fixture();
    mutate(data);
    const result = await run(data);
    assert.equal(result.approvals.length, 0);
  });
}

test('out-of-scope candidates are rejected before reading reviews or comments', async () => {
  const data = fixture();
  data.pr.labels = [];
  const { calls } = await run(data);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['pr']
  );
});

test('does not duplicate an existing Actions approval for the same SHA', async () => {
  const data = fixture();
  data.reviews = [{ user: { login: 'github-actions[bot]' }, state: 'APPROVED', commit_id: sha }];
  assert.equal((await run(data)).approvals.length, 0);
});

test('review-summary formatting is assessed by the meta-janitor, not the workflow', async () => {
  const data = fixture();
  data.comments[1].body = 'An entirely different review format assessed by the meta-janitor';
  data.reviews = [
    {
      user: bot,
      state: 'COMMENTED',
      body: 'Different review format',
      submitted_at: '2026-09-30T11:04:00Z',
    },
  ];
  assert.equal((await run(data)).approvals.length, 1);
  assert.doesNotMatch(script, /cleanSummary|cleanReview|kilo-review|No Issues Found/);
});

test('does not require a Markdown summary when the current Kilo check passed', async () => {
  const data = fixture();
  data.comments = data.comments.slice(0, 1);
  assert.equal((await run(data)).approvals.length, 1);
});

test('a Council Review block does not prevent the assessed commit being approved', async () => {
  const data = fixture();
  data.comments[1].body = data.comments[1].body.replace(
    '<!-- kilo-review -->',
    '<!-- kilo-review -->\n\n<!-- kilo-council-verdict:start -->\n## Council Review\nA council verdict\n<!-- kilo-council-verdict:end -->\n'
  );
  assert.equal((await run(data)).approvals.length, 1);
});

test('a dismissed previous Actions approval does not prevent a fresh approval', async () => {
  const data = fixture();
  data.reviews = [{ user: { login: 'github-actions[bot]' }, state: 'DISMISSED', commit_id: sha }];
  assert.equal((await run(data)).approvals.length, 1);
});

test('uses the newest commit status rather than an older failure', async () => {
  const data = fixture();
  data.statuses = [
    { context: 'external', state: 'success' },
    { context: 'external', state: 'failure' },
  ];
  assert.equal((await run(data)).approvals.length, 1);
  data.statuses.reverse();
  assert.equal((await run(data)).approvals.length, 0);
});

test('permits path-gated skipped checks while requiring successful Kilo review', async () => {
  const data = fixture();
  data.checks[0].conclusion = 'skipped';
  assert.equal((await run(data)).approvals.length, 1);
});

test('a commit status can satisfy an unpinned required context', async () => {
  const data = fixture();
  data.rules[1].parameters.required_status_checks = [{ context: 'external' }];
  data.statuses = [{ context: 'external', state: 'success' }];
  assert.equal((await run(data)).approvals.length, 1);
});

test('API failure aborts without approval', async () => {
  const data = fixture();
  data.apiFailure = 'reviews';
  await assert.rejects(run(data), /GitHub API unavailable/);
});

for (const key of ['checks', 'statuses', 'reviews', 'inlineComments', 'comments']) {
  test(`refreshes ${key} before approval and rejects late changes`, async () => {
    const data = fixture();
    data.currentLists = {
      checks: data.checks.map(check => ({ ...check, conclusion: 'failure' })),
      statuses: [{ context: 'external', state: 'failure' }],
      reviews: [{ user: { login: 'human' }, state: 'CHANGES_REQUESTED' }],
      inlineComments: [{ user: bot, body: 'New finding' }],
      comments: [
        ...data.comments,
        { user: { login: 'human' }, updated_at: '2026-09-30T12:01:00Z' },
      ],
    };
    data.currentLists = { [key]: data.currentLists[key] };
    const result = await run(data);
    assert.equal(result.approvals.length, 0);
    assert.equal(result.calls.filter(([route]) => route === key).length, 2);
  });
}

test('a second-pass API failure aborts without approval', async () => {
  const data = fixture();
  data.finalApiFailure = 'reviews';
  await assert.rejects(run(data), /GitHub API unavailable/);
});

test('successful approval refreshes every mutable input', async () => {
  const { calls, approvals } = await run(fixture());
  assert.equal(approvals.length, 1);
  for (const key of ['checks', 'statuses', 'reviews', 'inlineComments', 'comments']) {
    assert.equal(calls.filter(([route]) => route === key).length, 2);
  }
  assert.equal(calls.filter(([route]) => route === 'pr').length, 3);
  assert.equal(calls.filter(([route]) => route === 'signal').length, 3);
});
