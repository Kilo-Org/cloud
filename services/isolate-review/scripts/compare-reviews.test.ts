import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  buildReport,
  createReviewApi,
  runComparison,
  validateOptions,
  type Options,
  type Snapshot,
} from './compare-reviews.ts';
import {
  ControlDiagnostic,
  Ledger,
  Preparation,
  addKnownControlChildren,
  aggregateArms,
  combineMatches,
  createPrivateArtifacts,
  findingQuality,
  fixturePrompt,
  hashText,
  jsonRequest,
  normalizeFinding,
  readPrivateJson,
  redactArtifact,
  unmeasuredCost,
  unwrapArtifact,
  usageCost,
  verifyControl,
  type Arm,
  type Finding,
} from './review-evidence.ts';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const mergeSha = 'c'.repeat(40);
const candidateId = '10000000-0000-4000-8000-000000000001';
const controlId = '20000000-0000-4000-8000-000000000002';
const attemptId = '30000000-0000-4000-8000-000000000003';
const orgId = '40000000-0000-4000-8000-000000000004';
const previousRunId = '50000000-0000-4000-8000-000000000005';
const candidateUrl = 'https://github.com/owner/demo/pull/21';
const controlUrl = 'https://github.com/owner/demo/pull/22';
const time = '2026-08-27T18:00:00.000Z';
const preparation = Preparation.parse({
  version: 1,
  requestingUserId: 'oauth/human',
  executionUserId: 'oauth/human',
  settings: {
    model: 'test/concrete',
    thinkingEffort: 'high',
    modelSource: 'repository',
    analyticsEnabled: true,
    customInstructions: 'Saved instructions remain on the server.',
  },
  snapshot: { headSha, baseTipSha: baseSha, mergeBaseSha: mergeSha },
  hashes: {
    settings: hashText('settings'),
    context: hashText('context'),
    canonicalPrompt: hashText('canonical'),
    adaptedPrompt: hashText('adapted'),
    system: hashText('system'),
  },
});
const initial: Snapshot = {
  headSha,
  baseTipSha: baseSha,
  title: 'Disposable demo',
  body: '',
  state: 'open',
  draft: false,
  issueComments: [],
  reviews: [],
  inlineComments: [],
};
const options: Options = {
  candidateUrl,
  expectedHeadSha: headSha,
  webUrl: 'http://127.0.0.1:3200',
  out: '/unused/test-output',
  run: false,
  candidateLive: false,
  publishControl: false,
  confirmProviderMode: false,
  confirmDisposablePrs: false,
};
const paired: Options = {
  ...options,
  controlUrl,
  run: true,
  publishControl: true,
  confirmProviderMode: true,
  confirmDisposablePrs: true,
};
const finding: Finding = {
  path: 'src/page.tsx',
  currentLine: 4,
  side: 'RIGHT',
  severity: 'high',
  description: 'Uses browser-only storage during server rendering.',
  validity: 'valid',
  novelty: 'new',
  location: 'inline',
  proposed: true,
  published: false,
  lineTarget: 'correct',
  expectedDefectId: 'defect-1',
};

before(() => {
  mock.method(globalThis, 'fetch', () => {
    throw new Error('Real network is forbidden in runner tests');
  });
});
after(() => mock.restoreAll());

function controlStatus(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    review: {
      id: controlId,
      status: 'completed',
      head_sha: headSha,
      model: preparation.settings.model,
      cli_session_id: 'ses_control',
      manual_config: {
        outputMode: 'provider',
        agentConfig: {
          model_slug: preparation.settings.model,
          thinking_effort: 'high',
          review_analytics_enabled: false,
        },
      },
      created_at: '2026-08-27 18:00:00+00',
      started_at: '2026-08-27 18:00:01+00',
      completed_at: '2026-08-27 18:00:03+00',
      ...overrides,
    },
    attempts: [
      {
        id: attemptId,
        attempt_number: 1,
        analytics_enabled_at_dispatch: true,
        cli_session_id: 'ses_control',
      },
    ],
  };
}

function candidateStatus(overrides: Record<string, unknown> = {}) {
  return {
    runId: candidateId,
    status: 'completed',
    headSha,
    baseTipSha: baseSha,
    mergeBaseSha: mergeSha,
    requestedModel: preparation.settings.model,
    dryRun: true,
    inference: { modelId: preparation.settings.model, thinkingEffort: 'high' },
    createdAt: time,
    startedAt: '2026-08-27T18:00:01.000Z',
    cloneCompletedAt: '2026-08-27T18:00:02.000Z',
    completedAt: '2026-08-27T18:00:03.000Z',
    cloneMs: 500,
    usageSessions: [candidateId, 'candidate-child'],
    requestIds: ['candidate-request'],
    analysisOutcome: { status: 'completed', stepCount: 3, contextIncompleteReasons: [] },
    publicationOutcome: { review: 'proposed', summary: 'proposed' },
    terminationReason: 'completed',
    ...overrides,
  };
}

function driver(
  overrides: {
    call?: (method: 'GET' | 'POST', procedure: string, input: unknown) => Promise<unknown>;
    snapshot?: (url: string) => Promise<Snapshot>;
    sleep?: (ms: number) => Promise<unknown>;
  } = {}
) {
  let clock = Date.parse(time) + 10_000;
  const events: string[] = [];
  const calls: Array<{ method: 'GET' | 'POST'; procedure: string; input: unknown }> = [];
  const artifacts = new Map<string, unknown>();
  const defaultCall = async (_method: 'GET' | 'POST', procedure: string): Promise<unknown> => {
    if (procedure.endsWith('.createIsolateReview'))
      return {
        runId: candidateId,
        preparation,
        inference: {
          modelId: preparation.settings.model,
          thinkingEffort: 'high',
          provider: 'openrouter',
        },
      };
    if (procedure.endsWith('.createManualReviewJob'))
      return { reviewId: controlId, outputMode: 'provider' };
    if (procedure.endsWith('.getIsolateReview')) return candidateStatus();
    if (procedure === 'codeReviews.get') return controlStatus();
    return { runId: candidateId, messages: [], toolCalls: [] };
  };
  return {
    events,
    calls,
    artifacts,
    deps: {
      call: async (method: 'GET' | 'POST', procedure: string, input: unknown) => {
        events.push(`${method} ${procedure}`);
        calls.push({ method, procedure, input });
        clock += 100;
        return overrides.call
          ? overrides.call(method, procedure, input)
          : defaultCall(method, procedure);
      },
      snapshot: async (url: string) => {
        events.push(`snapshot ${url}`);
        return overrides.snapshot ? overrides.snapshot(url) : structuredClone(initial);
      },
      write: (name: string, data: unknown) => {
        assert.equal(artifacts.has(name), false);
        artifacts.set(name, structuredClone(data));
      },
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
        return overrides.sleep?.(ms);
      },
    },
    defaultCall,
  };
}

function arm(overrides: Partial<Arm> = {}): Arm {
  return {
    arm: 'candidate',
    id: candidateId,
    attempted: true,
    accepted: true,
    completed: true,
    status: 'completed',
    publicationRequested: false,
    publication: 'dry-run',
    inputMatch: 'matched',
    rootSessionIds: [candidateId],
    childSessionIds: [],
    requestIds: [],
    cost: unmeasuredCost(),
    ...overrides,
  };
}

function diagnostic(overrides: Record<string, unknown> = {}) {
  return ControlDiagnostic.parse({
    version: 1,
    source: 'private-captured-dispatch-diagnostic',
    phase: 'post-analytics-appendix',
    reviewId: controlId,
    attemptId,
    model: preparation.settings.model,
    variant: 'high',
    analytics_enabled_at_dispatch: true,
    promptSha256: hashText('actual control prompt including fix link'),
    promptLength: 900,
    packagedCliVersion: '7.4.20',
    ...overrides,
  });
}

void test('default preflight never calls HTTP, GitHub or inference', async () => {
  const run = driver();
  const result = await runComparison(options, run.deps);
  assert.deepEqual(run.events, []);
  assert.equal(result.mode, 'preflight');
  assert.equal(result.preparation, null);
  assert.equal(result.arms[0].attempted, false);
  assert.equal(result.arms[0].cost.billedMicrodollars, null);
  assert.ok(run.artifacts.has('comparison.json'));
});

void test('distinct publication gates fail closed, including truthy DEBUG_SHOW_DEV_UI=false', () => {
  assert.throws(() => validateOptions({ ...options, candidateLive: true }), /--run/);
  assert.throws(() => validateOptions({ ...paired, confirmDisposablePrs: false }), /disposable/);
  assert.throws(() => validateOptions({ ...paired, confirmProviderMode: false }), /provider-mode/);
  for (const flag of ['1', 'false', '0'])
    assert.throws(() => validateOptions(paired, flag), /DEBUG_SHOW_DEV_UI/);
  assert.throws(
    () => validateOptions({ ...paired, candidateLive: true, controlUrl: `${candidateUrl}/` }),
    /independent/
  );
  assert.throws(() => validateOptions({ ...options, thinkingEffort: 'high' }), /explicit model/);
  assert.throws(
    () => validateOptions({ ...options, model: 'kilo-auto/efficient', thinkingEffort: 'thinking' }),
    /router-owned/
  );
  assert.doesNotThrow(() => validateOptions({ ...options, model: 'kilo-auto/efficient' }));
});

void test('historic evidence PRs and credential-bearing or remote origins cannot be published to', () => {
  for (const number of [8, 9, 10]) {
    const url = `https://github.com/NA2-ORG/hi-how-are-you/pull/${number}/`;
    assert.throws(() => validateOptions({ ...paired, controlUrl: url }), /protected/);
    assert.throws(
      () => validateOptions({ ...paired, candidateLive: true, candidateUrl: url }),
      /protected/
    );
    assert.doesNotThrow(() => validateOptions({ ...options, candidateUrl: url }));
  }
  const credentialUrl = new URL('http://localhost:3200');
  credentialUrl.username = 'user';
  credentialUrl.password = 'secret';
  for (const webUrl of [
    'https://kilo.ai',
    credentialUrl.toString(),
    'http://localhost:3200/api',
    'http://localhost:3200/?token=secret',
  ])
    assert.throws(() => validateOptions({ ...options, webUrl }), /local Next.js origin/);
  assert.throws(() => validateOptions({ ...options, candidateUrl: `${candidateUrl}?publish=1` }));
});

void test('candidate resolves settings once, dry-runs first, and control receives only explicit pair and additive instructions', async () => {
  const run = driver();
  const result = await runComparison(
    { ...paired, instructions: '  Check error paths.  ' },
    run.deps
  );
  const posts = run.calls.filter(call => call.method === 'POST');
  assert.equal(result.errors.length, 0);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].procedure, 'personalReviewAgent.createIsolateReview');
  assert.deepEqual(posts[0].input, {
    url: candidateUrl,
    expectedHeadSha: headSha,
    dryRun: true,
    instructions: 'Check error paths.',
  });
  assert.deepEqual(posts[1].input, {
    platform: 'github',
    url: controlUrl,
    modelSlug: 'test/concrete',
    thinkingEffort: 'high',
    instructions: 'Check error paths.',
  });
  assert.ok(
    run.events.indexOf('GET personalReviewAgent.getIsolateReviewTranscript') <
      run.events.indexOf('POST personalReviewAgent.createManualReviewJob')
  );
  assert.equal(JSON.stringify(posts).includes('customInstructions'), false);
  assert.equal(JSON.stringify(posts[1]).includes('dryRun'), false);
  assert.equal(result.arms[0].inputMatch, 'matched');
  assert.equal(result.arms[1].inputMatch, 'pending');
  assert.deepEqual(result.arms[0].rootSessionIds, [candidateId]);
  assert.deepEqual(result.arms[0].childSessionIds, ['candidate-child']);
  assert.deepEqual(result.arms[0].requestIds, ['candidate-request']);
  assert.deepEqual(result.arms[1].rootSessionIds, ['ses_control']);
  assert.equal(result.arms[1].publication, 'unknown');
  assert.equal(result.arms[0].timing.latestSuccessfulCloneMs, 500);
  assert.equal(result.arms[0].timing.combinedExecutionMs, 2000);
  assert.equal(result.arms[0].timing.modelToolMs, null);
  assert.equal(result.arms[0].timing.publicationMs, null);
  assert.equal(result.arms[1].timing.acceptanceToExecutionOrCloneMs, 1000);
  assert.equal(result.arms[0].coverage.toolCallCount, 0);
});

void test('explicit inexpensive alias keeps null effort on both APIs and is labeled end-to-end', async () => {
  const run = driver();
  const settings = {
    ...preparation.settings,
    model: 'kilo-auto/efficient',
    thinkingEffort: null,
    modelSource: 'explicit',
  };
  const result = await runComparison(
    { ...paired, model: 'kilo-auto/efficient' },
    {
      ...run.deps,
      call: async (method, procedure, input) => {
        if (method === 'POST') {
          assert.equal(
            z.object({ modelSlug: z.string(), thinkingEffort: z.null() }).parse(input).modelSlug,
            'kilo-auto/efficient'
          );
          if (procedure.endsWith('.createIsolateReview'))
            return {
              runId: candidateId,
              preparation: { ...preparation, settings },
              inference: { modelId: settings.model, thinkingEffort: null },
            };
        }
        if (procedure.endsWith('.getIsolateReview'))
          return candidateStatus({
            requestedModel: settings.model,
            inference: { modelId: settings.model, thinkingEffort: null },
          });
        return run.defaultCall(method, procedure);
      },
    }
  );
  assert.equal(result.errors.length, 0);
  assert.equal(buildReport(result).comparisonKind, 'end-to-end-auto-alias');
});

void test('unexpected public-only control output remains an accepted mismatched arm', async () => {
  const run = driver();
  const result = await runComparison(paired, {
    ...run.deps,
    call: async (method, procedure) =>
      procedure.endsWith('.createManualReviewJob')
        ? { reviewId: controlId, outputMode: 'kilo' }
        : run.defaultCall(method, procedure),
  });
  assert.equal(result.arms[1].accepted, true);
  assert.equal(result.arms[1].inputMatch, 'mismatched');
  assert.equal(buildReport(result).matchedQualityEligible, false);
  assert.equal(buildReport(result).overall.accepted, 2);
});

void test('organization APIs and previousRunId keep server-owned summary authorization separate', async () => {
  const run = driver();
  const result = await runComparison(
    {
      ...options,
      run: true,
      candidateLive: true,
      confirmDisposablePrs: true,
      previousRunId,
      organizationId: orgId,
    },
    {
      ...run.deps,
      snapshot: async () => ({
        ...initial,
        issueComments: [{ id: 7, body: '<!-- kilo-review --> previous candidate summary' }],
      }),
      call: async (method, procedure, input) => {
        if (procedure.endsWith('.getIsolateReview'))
          return candidateStatus({
            dryRun: false,
            publicationOutcome: { review: 'confirmed', summary: 'confirmed' },
            published: true,
          });
        if (procedure.endsWith('.createIsolateReview')) {
          assert.equal(procedure, 'organizations.reviewAgent.createIsolateReview');
          assert.deepEqual(input, {
            organizationId: orgId,
            url: candidateUrl,
            expectedHeadSha: headSha,
            previousRunId,
            dryRun: false,
          });
          return {
            runId: candidateId,
            preparation: { ...preparation, organizationId: orgId },
            inference: { modelId: preparation.settings.model, thinkingEffort: 'high' },
          };
        }
        assert.equal(procedure, 'organizations.reviewAgent.getIsolateReviewTranscript');
        assert.deepEqual(input, { organizationId: orgId, runId: candidateId });
        return run.defaultCall(method, procedure);
      },
    }
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.arms[0].publication, 'confirmed');
});

void test('uncertain POST is attempted once, retained, and never followed by control', async () => {
  const run = driver({
    call: async () => {
      throw new Error('response lost');
    },
  });
  const result = await runComparison(paired, run.deps);
  assert.equal(run.calls.length, 1);
  assert.equal(result.arms[0].attempted, true);
  assert.equal(result.arms[0].accepted, null);
  assert.equal(result.arms[0].status, 'creation-uncertain');
  assert.equal(result.arms[0].inputMatch, 'pending');
  assert.equal(buildReport(result).matchedQualityEligible, false);
  assert.equal(result.arms[1].attempted, false);
  assert.ok(run.artifacts.has('candidate-request.json'));
  assert.ok(run.artifacts.has('candidate-outcome.json'));
});

void test('accepted ID survives malformed preparation and exports a transcript without a second POST', async () => {
  const run = driver({
    call: async method =>
      method === 'POST' ? { runId: candidateId, preparation: {} } : { messages: [], toolCalls: [] },
  });
  const result = await runComparison(paired, run.deps);
  assert.equal(result.arms[0].accepted, true);
  assert.equal(result.arms[0].id, candidateId);
  assert.equal(run.calls.filter(call => call.method === 'POST').length, 1);
  assert.ok(run.artifacts.has('candidate-transcript.json'));
});

void test('dry-run discussion mutation aborts control while retaining the completed candidate', async () => {
  let snapshots = 0;
  const run = driver({
    snapshot: async () =>
      ++snapshots > 2 ? { ...initial, issueComments: [{ id: 1, body: 'new comment' }] } : initial,
  });
  const result = await runComparison(paired, run.deps);
  assert.equal(result.arms[0].completed, true);
  assert.equal(result.arms[0].inputMatch, 'mismatched');
  assert.equal(result.arms[1].attempted, false);
  assert.equal(run.calls.filter(call => call.method === 'POST').length, 1);
  assert.match(result.errors[0], /discussion changed/);
});

void test('non-pristine control, different mirrored commits and changed predispatch state never publish', async () => {
  for (const changed of [
    { ...initial, reviews: [{ id: 1, body: 'historical' }] },
    { ...initial, headSha: 'd'.repeat(40) },
  ]) {
    const run = driver({ snapshot: async url => (url === controlUrl ? changed : initial) });
    const result = await runComparison(paired, run.deps);
    assert.equal(result.errors.length, 1);
    assert.equal(run.calls.length, 0);
  }
  let snapshots = 0;
  const run = driver({
    snapshot: async () => (++snapshots === 4 ? { ...initial, body: 'changed' } : initial),
  });
  const result = await runComparison(paired, run.deps);
  assert.equal(result.arms[1].attempted, false);
  assert.equal(result.checks['control.frozenDiscussion'], 'mismatched');
});

void test('failed and input-mismatched arms remain accepted, including earlier mismatches that later disappear', async () => {
  const run = driver();
  let polls = 0;
  const result = await runComparison(paired, {
    ...run.deps,
    call: async (method, procedure) => {
      if (procedure.endsWith('.getIsolateReview'))
        return ++polls === 1
          ? candidateStatus({
              status: 'running',
              completedAt: undefined,
              requestedModel: 'wrong/model',
            })
          : candidateStatus();
      if (procedure === 'codeReviews.get')
        return controlStatus({ status: 'failed', model: 'different/model' });
      return run.defaultCall(method, procedure);
    },
  });
  assert.equal(result.arms[0].accepted, true);
  assert.equal(result.arms[0].inputMatch, 'mismatched');
  assert.equal(result.arms[0].observations.length, 2);
  assert.equal(result.arms[1].accepted, true);
  assert.equal(result.arms[1].completed, false);
  assert.equal(result.arms[1].inputMatch, 'mismatched');
  assert.equal(buildReport(result).overall.completionReliability, 0.5);
});

void test('poll timeout retains last evidence, reads transcript, and stops before control', async () => {
  const run = driver();
  let clock = Date.parse(time);
  const result = await runComparison(paired, {
    ...run.deps,
    now: () => clock,
    sleep: async () => {
      clock += 2_000_000;
    },
    call: async (method, procedure) =>
      procedure.endsWith('.getIsolateReview')
        ? candidateStatus({ status: 'running', completedAt: undefined })
        : run.defaultCall(method, procedure),
  });
  assert.equal(result.arms[0].status, 'poll-timeout');
  assert.equal(result.arms[0].accepted, true);
  assert.equal(result.arms[1].attempted, false);
  assert.ok(run.artifacts.has('candidate-transcript.json'));
});

void test('a completed flag without completed analysis is not a successful candidate investigation', async () => {
  const run = driver();
  const result = await runComparison(
    { ...options, run: true },
    {
      ...run.deps,
      call: async (method, procedure) =>
        procedure.endsWith('.getIsolateReview')
          ? candidateStatus({
              analysisOutcome: { status: 'incomplete', incompleteTaskIds: ['child'] },
            })
          : run.defaultCall(method, procedure),
    }
  );
  assert.equal(result.arms[0].completed, false);
  assert.deepEqual(result.arms[0].coverage.analysis, {
    status: 'incomplete',
    incompleteTaskIds: ['child'],
  });
});

void test('one successful arm plus an expensive FAILED mismatch retains all reliability and cost numerators', () => {
  const succeeded = arm({ cost: { ...unmeasuredCost(), billedMicrodollars: '1000000' } });
  const failed = arm({
    id: controlId,
    arm: 'control',
    completed: false,
    status: 'FAILED',
    inputMatch: 'mismatched',
    publicationRequested: true,
    publication: 'uncertain',
    cost: { ...unmeasuredCost(), billedMicrodollars: '9000000' },
  });
  const report = aggregateArms([succeeded, failed], [finding]);
  assert.equal(report.attempted, 2);
  assert.equal(report.accepted, 2);
  assert.equal(report.completed, 1);
  assert.equal(report.completionReliability, 0.5);
  assert.equal(report.inputMismatches, 1);
  assert.deepEqual(report.publicationReliability, {
    acceptedPublishingRuns: 1,
    confirmed: 0,
    unknown: 1,
    confirmedFractionLowerBound: 0,
  });
  assert.equal(report.cost.knownBilledMicrodollars, '10000000');
  assert.deepEqual(report.cost.perCompletedReview, {
    numeratorMicrodollars: '10000000',
    denominator: 1,
    accounting: 'known-lower-bound',
  });
  assert.equal(report.cost.perAttemptedRun?.denominator, 2);
  assert.equal(report.cost.perValidNewProposedFinding?.numeratorMicrodollars, '10000000');
  assert.equal(report.cost.perValidNewPublishedFinding, null);
  assert.equal(report.cost.favorableCompleteCostComparisonSupported, false);
  assert.equal(aggregateArms([failed]).cost.perCompletedReview, null);
  assert.equal(aggregateArms([arm()]).cost.knownBilledMicrodollars, null);
});

void test('cost sums are exact beyond safe integers, never sample estimates or complete-cost claims', () => {
  const report = aggregateArms([
    arm({ cost: { ...unmeasuredCost(), billedMicrodollars: '9007199254740993' } }),
    arm({ cost: { ...unmeasuredCost(), billedMicrodollars: '2' } }),
    arm(),
  ]);
  assert.equal(report.cost.knownBilledMicrodollars, '9007199254740995');
  assert.equal(report.cost.accounting, 'known-lower-bound');
  assert.equal(report.cost.knownMarketMicrodollars, null);
});

void test('stable finding normalization preserves side/current line and proposed versus published labels', () => {
  const original = normalizeFinding(finding);
  const equivalent = normalizeFinding({
    ...finding,
    path: '/workspace/./src/page.tsx',
    description: '\nUses browser-only storage\n during server rendering. ',
  });
  assert.equal(original.key, equivalent.key);
  assert.equal(original.published, false);
  assert.notEqual(original.key, normalizeFinding({ ...finding, side: 'LEFT' }).key);
  assert.throws(() => normalizeFinding({ ...finding, currentLine: null }), /current line/);
  assert.throws(() => normalizeFinding({ ...finding, path: '../secret' }), /traversal/);
  assert.throws(() => normalizeFinding({ ...finding, path: '/etc/secret' }), /relative/);
  assert.equal(
    normalizeFinding({ ...finding, currentLine: null, side: null, location: 'summary-only' })
      .currentLine,
    null
  );
});

void test('external ledger metrics label validity, duplicates, line targeting and expected defects without prompt injection', async () => {
  const quality = findingQuality(
    [
      finding,
      { ...finding, description: 'Duplicate', novelty: 'duplicate' },
      {
        ...finding,
        description: 'False positive',
        validity: 'invalid',
        lineTarget: 'incorrect',
        expectedDefectId: undefined,
      },
    ],
    [
      { id: 'defect-1', severity: 'high' },
      { id: 'missed', severity: 'critical' },
    ]
  );
  assert.equal(quality.recallLabeledDefectsProposed, 0.5);
  assert.equal(quality.precisionValidNewProposed, 1 / 3);
  assert.deepEqual(quality.highSeverityMisses, ['missed']);
  assert.equal(quality.duplicates, 1);
  assert.equal(quality.falsePositives, 1);
  assert.equal(quality.incorrectLineTargets, 1);
  const run = driver();
  const manifest = await runComparison(paired, run.deps);
  const ledger = Ledger.parse({
    version: 1,
    pairId: manifest.pairId,
    source: 'external-human-ledger',
    expectedDefects: [{ id: 'defect-1', severity: 'high' }],
    findings: { candidate: [finding], control: [] },
    summaryAccuracy: { candidate: 'accurate', control: 'unreviewed' },
  });
  assert.equal(buildReport(manifest, ledger).matchedQualityEligible, false);
  assert.deepEqual(buildReport(manifest, ledger), buildReport(manifest, ledger));
  assert.equal(JSON.stringify(run.calls).includes('defect-1'), false);
  assert.throws(() => buildReport(manifest, { ...ledger, pairId: 'different' }), /different pair/);
});

void test('unreviewed findings cannot become definite quality scores or high-severity misses', () => {
  const quality = findingQuality(
    [{ ...finding, validity: 'unreviewed' }],
    [{ id: 'defect-1', severity: 'high' }]
  );
  assert.equal(quality.adjudication, 'partial');
  assert.equal(quality.precisionValidNewProposed, null);
  assert.equal(quality.recallLabeledDefectsProposed, null);
  assert.equal(quality.highSeverityMisses, null);
  assert.deepEqual(quality.highSeverityNotConfirmed, ['defect-1']);
});

void test('full usage totals remain unproven and require known sessions, not review UUIDs or user windows', () => {
  const usage = {
    userId: 'oauth/human',
    scope: 'session-set',
    sessionIdsJson: JSON.stringify(['ses_control', 'ses_child']),
    aggregateCompleteness: 'all-matched-rows-at-query-time',
    runAccountingCompleteness: 'unproven',
    billedMicrodollars: '5000000',
    marketMicrodollars: null,
    inferenceBilledMicrodollars: '4900000',
    classifierBilledMicrodollars: '100000',
    matchedRows: 150,
    rows: 100,
    truncated: true,
    sampledCostMicrodollars: 1,
  };
  const control = arm({
    arm: 'control',
    id: controlId,
    rootSessionIds: ['ses_control'],
    childSessionIds: ['ses_child'],
  });
  const cost = usageCost(usage, control, 'oauth/human');
  assert.equal(cost.billedMicrodollars, '5000000');
  assert.equal(cost.accounting, 'unproven');
  assert.equal(cost.marketMicrodollars, null);
  assert.equal(cost.classifierBilledMicrodollars, '100000');
  for (const change of [
    { sessionIdsJson: JSON.stringify([controlId]) },
    { sessionIdsJson: JSON.stringify(['unknown-child']) },
    { scope: 'user-window' },
    { userId: 'another-user' },
    { runAccountingCompleteness: 'complete' },
  ])
    assert.throws(() => usageCost({ ...usage, ...change }, control, 'oauth/human'));
});

void test('control hash import uses actual post-analytics log spelling and keeps absent evidence pending', () => {
  const captured = diagnostic();
  assert.equal(verifyControl(preparation, controlStatus()).match, 'pending');
  const result = verifyControl(preparation, controlStatus(), captured);
  assert.equal(result.match, 'pending');
  assert.equal(result.checks.analyticsAtDispatch, 'matched');
  assert.equal(result.checks.dispatchedAnalytics, 'matched');
  assert.equal(result.checks.settingsHash, 'pending');
  assert.equal(result.promptHash, captured.promptSha256);
  assert.notEqual(result.promptHash, preparation.hashes.canonicalPrompt);
  assert.throws(() => diagnostic({ phase: 'before-analytics' }));
  const full = diagnostic({
    outputMode: 'provider',
    headSha,
    baseTipSha: baseSha,
    mergeBaseSha: mergeSha,
    settingsHash: preparation.hashes.settings,
    contextHash: preparation.hashes.context,
    skillVersion: 'captured-skill-sha',
  });
  assert.equal(verifyControl(preparation, controlStatus(), full).match, 'matched');
  assert.equal(
    verifyControl(preparation, controlStatus(), { ...full, analytics_enabled_at_dispatch: false })
      .match,
    'mismatched'
  );
  assert.equal(
    verifyControl(preparation, controlStatus(), { ...full, variant: null }).match,
    'mismatched'
  );
  assert.equal(combineMatches(['pending', 'matched', 'mismatched']), 'mismatched');
});

void test('a concrete model from alias billing is recorded, not mistaken for a changed dispatch alias', () => {
  const prepared = Preparation.parse({
    ...preparation,
    settings: { ...preparation.settings, model: 'kilo-auto/efficient', thinkingEffort: null },
  });
  const status = controlStatus({
    model: 'qwen/qwen3.7-plus',
    manual_config: {
      outputMode: 'provider',
      agentConfig: { model_slug: 'kilo-auto/efficient', thinking_effort: null },
    },
  });
  assert.equal(verifyControl(prepared, status).checks.observedModel, 'pending');
  assert.equal(
    verifyControl(prepared, status, diagnostic({ model: 'kilo-auto/efficient', variant: null }))
      .checks.observedModel,
    'matched'
  );
});

void test('analytics uses the latest persisted attempt, not preference or missing decisions', () => {
  const status = controlStatus();
  status.attempts.push({
    id: previousRunId,
    attempt_number: 2,
    analytics_enabled_at_dispatch: false,
    cli_session_id: 'ses_retry',
  });
  assert.equal(verifyControl(preparation, status).checks.analyticsAtDispatch, 'mismatched');
  const missing = {
    ...controlStatus(),
    attempts: [{ id: attemptId, attempt_number: 1, analytics_enabled_at_dispatch: null }],
  };
  assert.equal(verifyControl(preparation, missing).checks.analyticsAtDispatch, 'pending');
});

void test('control child usage mapping must lead to a known CLI root, never a review UUID', () => {
  const control = arm({ arm: 'control', id: controlId, rootSessionIds: ['ses_control'] });
  const mapped = addKnownControlChildren(
    control,
    diagnostic({
      childSessions: [
        { parentSessionId: 'ses_child', sessionId: 'ses_grandchild' },
        { parentSessionId: 'ses_control', sessionId: 'ses_child' },
      ],
      requestIds: ['request-1'],
    })
  );
  assert.deepEqual(mapped.childSessionIds, ['ses_child', 'ses_grandchild']);
  assert.deepEqual(mapped.requestIds, ['request-1']);
  assert.throws(
    () =>
      addKnownControlChildren(
        control,
        diagnostic({ childSessions: [{ parentSessionId: controlId, sessionId: 'ses_unknown' }] })
      ),
    /unknown parent/
  );
  assert.throws(
    () => addKnownControlChildren(control, diagnostic({ reviewId: candidateId })),
    /another review/
  );
});

void test('private versioned artifacts redact credentials, reject public/symlink input and never overwrite evidence', () => {
  const parent = mkdtempSync(join(tmpdir(), 'review-runner-test-'));
  try {
    const directory = join(parent, 'evidence');
    const write = createPrivateArtifacts(directory, ['literal-secret']);
    write('status.json', {
      headers: { Authorization: 'hidden' },
      INTERNAL_API_SECRET: 'other-secret',
      nested: [
        'literal-secret',
        'Bearer never-save-this',
        'ghp_syntheticfixture',
        'eyJhbGciOiJIUzI1NiJ9.payload.signature',
      ],
      grossInputTokens: 7,
      text: 'ordinary review evidence',
    });
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    const path = join(directory, 'status.json');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const contents = readFileSync(path, 'utf8');
    for (const secret of [
      'hidden',
      'other-secret',
      'literal-secret',
      'never-save-this',
      'ghp_syntheticfixture',
      'eyJhbGci',
    ])
      assert.equal(contents.includes(secret), false);
    assert.equal(
      z.object({ grossInputTokens: z.number() }).parse(unwrapArtifact(readPrivateJson(path)))
        .grossInputTokens,
      7
    );
    assert.throws(() => write('status.json', {}));
    assert.throws(() => createPrivateArtifacts(directory));
    assert.throws(() => write('../escape.json', {}));
    const link = join(directory, 'link.json');
    symlinkSync(path, link);
    assert.throws(() => readPrivateJson(link), /private regular files/);
    chmodSync(path, 0o644);
    assert.throws(() => readPrivateJson(path), /private regular files/);
    const credentialUrl = new URL('https://example.test');
    credentialUrl.username = 'user';
    credentialUrl.password = 'password';
    assert.equal(redactArtifact(credentialUrl.toString()), 'https://[REDACTED]@example.test/');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

void test('fixture seam accepts canonical artifact bytes or simple text without importing the render owner', () => {
  const text = '  Canonically rendered fixture prompt\n';
  const expected = { owner: 'kilo-e2e', repo: 'review-fixture', pullNumber: 1, headSha };
  const artifact = {
    ...expected,
    userPrompt: text,
    model: preparation.settings.model,
    thinkingEffort: 'high',
    preparation: {
      ...preparation,
      hashes: { ...preparation.hashes, adaptedPrompt: hashText(text) },
    },
  };
  assert.deepEqual(fixturePrompt(artifact, expected), {
    source: 'canonical-prepared-request',
    userPrompt: text,
    model: preparation.settings.model,
    thinkingEffort: 'high',
  });
  assert.deepEqual(fixturePrompt(text), { source: 'fixture-text', userPrompt: text });
  assert.throws(() => fixturePrompt({ version: 1, userPrompt: text }));
  assert.throws(() => fixturePrompt({ ...artifact, userPrompt: 'altered' }, expected), /hash/);
  assert.throws(() => fixturePrompt({ ...artifact, gitToken: 'forbidden' }, expected));
  assert.throws(() => fixturePrompt(artifact, { ...expected, headSha: baseSha }), /fixture/);
  assert.throws(() => fixturePrompt({ ...artifact, thinkingEffort: null }, expected), /settings/);
  assert.throws(() => fixturePrompt(' '));
  assert.throws(() => fixturePrompt('x'.repeat(64_001)));
  const source = readFileSync(new URL('./run-e2e.ts', import.meta.url), 'utf8');
  assert.equal(source.includes("from './render-live-prompt.ts'"), false);
});

void test('authenticated API uses plain tRPC bodies, nonredirecting requests, and no billing bypass or retry', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    if (typeof url !== 'string') throw new Error('Expected string URL');
    calls.push({ url, init });
    return Response.json({ result: { data: { runId: candidateId } } });
  };
  const api = createReviewApi('http://127.0.0.1:3200', 'test-bearer', fetchImpl);
  await api('POST', 'personalReviewAgent.createIsolateReview', { url: candidateUrl, dryRun: true });
  await api('GET', 'personalReviewAgent.getIsolateReview', { runId: candidateId });
  assert.deepEqual(JSON.parse(z.string().parse(calls[0].init?.body)), {
    url: candidateUrl,
    dryRun: true,
  });
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer test-bearer');
  assert.equal(new Headers(calls[0].init?.headers).has('x-skip-balance-check'), false);
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(
    new URL(calls[1].url).searchParams.get('input'),
    JSON.stringify({ runId: candidateId })
  );
  let failures = 0;
  const failing: typeof fetch = async () => {
    failures++;
    throw new Error('Bearer secret-response');
  };
  await assert.rejects(
    createReviewApi('http://127.0.0.1:3200', 'test', failing)(
      'POST',
      'personalReviewAgent.createIsolateReview',
      {}
    ),
    error => error instanceof Error && !error.message.includes('secret-response')
  );
  assert.equal(failures, 1);
  assert.deepEqual(
    await jsonRequest(
      'http://localhost',
      {},
      async () => new Response('secret-error-body', { status: 500 })
    ),
    { status: 500, body: null }
  );
});

void test('offline report CLI attaches captured diagnostics and full usage while retaining expensive failure', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'review-report-test-'));
  try {
    const pairDirectory = join(parent, 'pair');
    const run = driver();
    const manifest = await runComparison(paired, {
      ...run.deps,
      write: createPrivateArtifacts(pairDirectory),
      call: async (method, procedure) =>
        procedure === 'codeReviews.get'
          ? controlStatus({ status: 'failed' })
          : run.defaultCall(method, procedure),
    });
    const save = (name: string, value: unknown) => {
      const path = join(parent, name);
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
      return path;
    };
    const labels = save('labels.json', {
      version: 1,
      pairId: manifest.pairId,
      source: 'external-human-ledger',
      expectedDefects: [{ id: 'defect-1', severity: 'high' }],
      findings: { candidate: [finding], control: [] },
      summaryAccuracy: { candidate: 'accurate', control: 'unreviewed' },
    });
    const captured = save(
      'diagnostic.json',
      diagnostic({
        outputMode: 'provider',
        headSha,
        baseTipSha: baseSha,
        mergeBaseSha: mergeSha,
        settingsHash: preparation.hashes.settings,
        contextHash: preparation.hashes.context,
        skillVersion: 'captured-skill-sha',
      })
    );
    const usage = {
      userId: 'oauth/human',
      scope: 'session',
      aggregateCompleteness: 'all-matched-rows-at-query-time',
      runAccountingCompleteness: 'unproven',
      marketMicrodollars: null,
      classifierBilledMicrodollars: 0,
    };
    const candidateUsage = save('candidate-usage.json', {
      ...usage,
      sessionIdsJson: JSON.stringify([candidateId]),
      billedMicrodollars: 1000,
      inferenceBilledMicrodollars: 1000,
    });
    const controlUsage = save('control-usage.json', {
      ...usage,
      sessionIdsJson: JSON.stringify(['ses_control']),
      billedMicrodollars: 9000,
      inferenceBilledMicrodollars: 9000,
    });
    const output = join(parent, 'report');
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./compare-reviews.ts', import.meta.url)),
        '--report',
        join(pairDirectory, 'comparison.json'),
        '--ledger',
        labels,
        '--control-diagnostic',
        captured,
        '--candidate-usage',
        candidateUsage,
        '--control-usage',
        controlUsage,
        '--out',
        output,
      ],
      { encoding: 'utf8', stdio: 'pipe' }
    );
    const report = z
      .object({
        matchedQualityEligible: z.boolean(),
        conditionalCompletedQualityEligible: z.boolean(),
        overall: z.object({
          accepted: z.number(),
          completed: z.number(),
          cost: z.object({
            knownBilledMicrodollars: z.string(),
            perCompletedReview: z.object({
              numeratorMicrodollars: z.string(),
              denominator: z.number(),
            }),
          }),
        }),
      })
      .parse(unwrapArtifact(readPrivateJson(join(output, 'report.json'))));
    assert.equal(report.matchedQualityEligible, true);
    assert.equal(report.conditionalCompletedQualityEligible, false);
    assert.equal(report.overall.accepted, 2);
    assert.equal(report.overall.completed, 1);
    assert.equal(report.overall.cost.knownBilledMicrodollars, '10000');
    assert.deepEqual(report.overall.cost.perCompletedReview, {
      numeratorMicrodollars: '10000',
      denominator: 1,
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

void test('CLI help and preflights are runnable without authentication, services, or network', () => {
  const parent = mkdtempSync(join(tmpdir(), 'review-cli-test-'));
  const compare = fileURLToPath(new URL('./compare-reviews.ts', import.meta.url));
  const fixture = fileURLToPath(new URL('./run-e2e.ts', import.meta.url));
  const env = { ...process.env, KILO_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  try {
    const help = execFileSync(process.execPath, ['--import', 'tsx', compare, '--help'], {
      encoding: 'utf8',
      env,
    });
    assert.match(help, /Default: offline CLI preflight/);
    const out = join(parent, 'preflight');
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        compare,
        '--candidate-url',
        candidateUrl,
        '--expected-head-sha',
        headSha,
        '--web-url',
        'http://127.0.0.1:1',
        '--out',
        out,
      ],
      { encoding: 'utf8', env }
    );
    assert.ok(readPrivateJson(join(out, 'comparison.json')));
    const fixtureOut = execFileSync(process.execPath, ['--import', 'tsx', fixture], {
      encoding: 'utf8',
      env,
    });
    assert.match(fixtureOut, /no services or inference started/);
    const label = join(parent, 'private-label.json');
    writeFileSync(label, '{}', { mode: 0o600 });
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', compare, '--ledger', label, '--out', join(parent, 'rejected')],
        { encoding: 'utf8', env, stdio: 'pipe' }
      )
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
