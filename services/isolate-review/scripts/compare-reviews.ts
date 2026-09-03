import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import {
  Arm,
  ControlDiagnostic,
  Effort,
  Id,
  JsonRecord,
  Ledger,
  Match,
  Model,
  Preparation,
  Sha,
  Timestamp,
  addKnownControlChildren,
  aggregateArms,
  combineMatches,
  compareValue,
  createPrivateArtifacts,
  findingQuality,
  hashText,
  jsonRequest,
  readPrivateJson,
  readPrivateText,
  redactArtifact,
  unmeasuredCost,
  unwrapArtifact,
  usageCost,
  verifyControl,
} from './review-evidence.ts';

const POLL_MS = 5_000;
const TIMEOUT_MS = 20 * 60_000;
const execFileAsync = promisify(execFile);
const PR = z
  .string()
  .regex(
    /^https:\/\/github\.com\/[a-zA-Z0-9][a-zA-Z0-9-]*\/(?!\.{1,2}\/)[a-zA-Z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/
  )
  .transform(value => value.replace(/\/$/, '').toLowerCase())
  .refine(value => Number.isSafeInteger(Number(value.split('/').at(-1))));

const Options = z.object({
  candidateUrl: PR,
  controlUrl: PR.optional(),
  expectedHeadSha: Sha,
  webUrl: z.string().url(),
  out: z.string().min(1),
  model: Model.optional(),
  thinkingEffort: Effort.optional(),
  instructions: z.string().trim().max(4_000).optional(),
  organizationId: z.uuid().optional(),
  previousRunId: z.uuid().optional(),
  run: z.boolean(),
  candidateLive: z.boolean(),
  publishControl: z.boolean(),
  confirmProviderMode: z.boolean(),
  confirmDisposablePrs: z.boolean(),
});
export type Options = z.infer<typeof Options>;

export function validateOptions(input: Options, debugShowDevUi?: string): Options {
  const options = Options.parse(input);
  const web = new URL(options.webUrl);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(web.hostname) ||
    !['http:', 'https:'].includes(web.protocol) ||
    web.username ||
    web.password ||
    web.search ||
    web.hash ||
    web.pathname !== '/'
  ) {
    throw new Error('Use the existing local Next.js origin without credentials, path or query');
  }
  if (options.thinkingEffort !== undefined && options.model === undefined)
    throw new Error('thinking effort requires an explicit model');
  if (options.model?.startsWith('kilo-auto/') && options.thinkingEffort != null)
    throw new Error('Auto aliases require router-owned effort');
  if ((options.candidateLive || options.publishControl) && !options.run)
    throw new Error('Publication flags also require --run');
  if ((options.candidateLive || options.publishControl) && !options.confirmDisposablePrs)
    throw new Error('Publication requires --confirm-disposable-prs');
  if (
    options.publishControl &&
    (!options.controlUrl || !options.confirmProviderMode || debugShowDevUi)
  )
    throw new Error(
      'Control requires --control-url, --confirm-provider-mode and empty DEBUG_SHOW_DEV_UI on the server'
    );
  if (
    options.candidateLive &&
    options.publishControl &&
    options.candidateUrl === options.controlUrl
  )
    throw new Error('Live comparison requires independent disposable PR URLs');
  for (const url of [
    options.candidateLive ? options.candidateUrl : undefined,
    options.publishControl ? options.controlUrl : undefined,
  ]) {
    if (url && /^https:\/\/github\.com\/na2-org\/hi-how-are-you\/pull\/(?:8|9|10)$/.test(url))
      throw new Error('Historical evidence PRs #8/#9/#10 are protected from publication');
  }
  return options;
}

const Snapshot = z.object({
  headSha: Sha,
  baseTipSha: Sha,
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  draft: z.boolean(),
  issueComments: z.array(JsonRecord),
  reviews: z.array(JsonRecord),
  inlineComments: z.array(JsonRecord),
});
export type Snapshot = z.infer<typeof Snapshot>;

function snapshotHash(snapshot: Snapshot): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)])
      );
    return value;
  };
  return hashText(JSON.stringify(canonical(snapshot)));
}

function emptyDiscussion(snapshot: Snapshot): boolean {
  return (
    snapshot.issueComments.length === 0 &&
    snapshot.reviews.length === 0 &&
    snapshot.inlineComments.length === 0
  );
}

async function githubSnapshot(url: string): Promise<Snapshot> {
  const [, owner, repo, , pull] = new URL(PR.parse(url)).pathname.split('/');
  const base = `repos/${owner}/${repo}`;
  const read = async (path: string, pages = false): Promise<unknown> => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'api',
          '--hostname',
          'github.com',
          '--method',
          'GET',
          ...(pages ? ['--paginate', '--slurp'] : []),
          path,
        ],
        { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }
      );
      return JSON.parse(stdout);
    } catch {
      throw new Error('Read-only GitHub snapshot unavailable; no review should be started');
    }
  };
  const Pull = z.object({
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.string(),
    draft: z.boolean(),
    head: z.object({ sha: Sha }),
    base: z.object({ sha: Sha, repo: z.object({ full_name: z.string() }) }),
  });
  const before = Pull.parse(await read(`${base}/pulls/${pull}`));
  const pageRecords = z.array(z.array(JsonRecord));
  const issueComments = pageRecords
    .parse(await read(`${base}/issues/${pull}/comments?per_page=100`, true))
    .flat();
  const reviews = pageRecords
    .parse(await read(`${base}/pulls/${pull}/reviews?per_page=100`, true))
    .flat();
  const inlineComments = pageRecords
    .parse(await read(`${base}/pulls/${pull}/comments?per_page=100`, true))
    .flat();
  const after = Pull.parse(await read(`${base}/pulls/${pull}`));
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    after.number !== Number(pull) ||
    after.base.repo.full_name.toLowerCase() !== `${owner}/${repo}`
  )
    throw new Error('PR changed during snapshot collection');
  return {
    headSha: after.head.sha,
    baseTipSha: after.base.sha,
    title: after.title,
    body: after.body,
    state: after.state,
    draft: after.draft,
    issueComments,
    reviews,
    inlineComments,
  };
}

export function createReviewApi(webUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
  return async (method: 'GET' | 'POST', procedure: string, input: unknown): Promise<unknown> => {
    const url = new URL(`/api/trpc/${procedure}`, webUrl);
    if (method === 'GET') url.searchParams.set('input', JSON.stringify(input));
    const response = await jsonRequest(
      url.href,
      {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
      },
      fetchImpl
    );
    const envelope = z.object({ result: z.object({ data: z.unknown() }) }).safeParse(response.body);
    if (response.status !== 200 || !envelope.success)
      throw new Error(
        'tRPC response unavailable or rejected; creation acceptance may be uncertain; never retry POST'
      );
    const data = envelope.data.result.data;
    if (JsonRecord.safeParse(data).data?.success === false)
      throw new Error('tRPC read reported failure');
    return data;
  };
}

type Dependencies = {
  call: ReturnType<typeof createReviewApi>;
  snapshot: (url: string) => Promise<Snapshot>;
  write: (name: string, data: unknown) => void;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
};

const RunArm = Arm.extend({
  observations: z.array(z.object({ at: Timestamp, status: z.string() })),
  timing: JsonRecord,
  statusEvidence: JsonRecord.nullable(),
  coverage: JsonRecord,
  error: z.string().nullable(),
});
type RunArm = z.infer<typeof RunArm>;
export const Comparison = z.object({
  pairId: z.uuid(),
  mode: z.enum(['preflight', 'quality', 'live']),
  candidateUrl: PR,
  controlUrl: PR.nullable(),
  expectedHeadSha: Sha,
  preparation: Preparation.nullable(),
  inference: JsonRecord.nullable(),
  arms: z.array(RunArm),
  checks: z.record(z.string(), Match),
  errors: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type Comparison = z.infer<typeof Comparison>;

function newArm(arm: 'candidate' | 'control', live: boolean): RunArm {
  return {
    arm,
    id: null,
    attempted: false,
    accepted: false,
    completed: false,
    status: 'not-started',
    publicationRequested: live,
    publication: live ? 'unknown' : 'dry-run',
    inputMatch: 'pending',
    rootSessionIds: [],
    childSessionIds: [],
    requestIds: [],
    cost: unmeasuredCost(),
    observations: [],
    timing: {},
    statusEvidence: null,
    coverage: { analysis: 'unknown', publication: 'unknown', transcript: 'not-collected' },
    error: null,
  };
}

function safeError(error: unknown): string {
  return error instanceof z.ZodError
    ? 'Invalid API or artifact contract'
    : error instanceof Error
      ? error.message
      : 'Unknown failure';
}

function duration(start: unknown, end: unknown): number | null {
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const result = Date.parse(end) - Date.parse(start);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function updateTiming(arm: RunArm, status: Record<string, unknown>, now: string) {
  const candidate = arm.arm === 'candidate';
  const started = candidate ? status.startedAt : status.started_at;
  const accepted = candidate ? status.createdAt : status.created_at;
  const terminal = candidate ? status.completedAt : status.completed_at;
  arm.timing = {
    ...arm.timing,
    serverAcceptedAt: accepted ?? null,
    executionOrCloneStartedAt: started ?? null,
    cloneCompletedAt: candidate ? (status.cloneCompletedAt ?? null) : null,
    serverTerminalAt: terminal ?? null,
    finalObservedAt: now,
    requestToAcceptanceMs: duration(arm.timing.requestStartedAt, arm.timing.acceptedObservedAt),
    acceptanceToExecutionOrCloneMs: duration(accepted, started),
    latestSuccessfulCloneMs: candidate ? (status.cloneMs ?? null) : null,
    combinedExecutionMs: duration(started, terminal),
    modelToolMs: null,
    publicationMs: null,
    firstModelResponseAt: null,
    firstContentAt: null,
    pollingDelayMs: duration(terminal, arm.timing.terminalObservedAt),
    observedEndToEndMs: duration(arm.timing.requestStartedAt, now),
  };
  const publication = JsonRecord.safeParse(status.publicationOutcome).data;
  if (candidate && publication?.review === 'confirmed' && typeof status.githubReviewId === 'number')
    arm.timing.firstInlineReviewConfirmedObservedAt ??= now;
  if (
    candidate &&
    publication?.summary === 'confirmed' &&
    typeof status.summaryCommentId === 'number'
  )
    arm.timing.summaryConfirmedObservedAt ??= now;
}

export async function runComparison(options: Options, deps: Dependencies): Promise<Comparison> {
  options = validateOptions(options);
  const manifest: Comparison = {
    pairId: randomUUID(),
    mode: options.run ? (options.candidateLive ? 'live' : 'quality') : 'preflight',
    candidateUrl: options.candidateUrl,
    controlUrl: options.controlUrl ?? null,
    expectedHeadSha: options.expectedHeadSha,
    preparation: null,
    inference: null,
    arms: [
      newArm('candidate', options.candidateLive),
      ...(options.publishControl ? [newArm('control', true)] : []),
    ],
    checks: {},
    errors: [],
    limitations: [
      'Preflight validates CLI inputs only: no preparation-only API exists. --run spends on candidate inference even in dry-run.',
      'Server DEBUG_SHOW_DEV_UI must be empty; operator attestation precedes POST and returned outputMode is checked afterwards.',
      'PR/discussion snapshots are read observations, not atomic provider locks; freeze both PRs and saved settings throughout the run.',
      'Control transcript is the existing formatted session log, not proof of complete prompt/child telemetry.',
      'Control post-analytics prompt/skill diagnostics require a private captured artifact; absent evidence stays pending.',
      'Session mappings and usage settlement are unproven; model cost remains unknown or a lower bound. Gateway and infrastructure costs are unmeasured.',
      'Execution/clone, model/tool, publication and polling phases are not interchangeable; missing milestones remain null.',
      'Single manual pair only; no statistical parity, non-inferiority or cost-superiority claim.',
    ],
  };
  for (const name of [
    'candidate.preparedHead',
    'candidate.organization',
    'candidate.inferenceModel',
    'candidate.inferenceEffort',
    'candidate.statusIdentity',
    'candidate.statusHead',
    'candidate.statusBaseTip',
    'candidate.statusMergeBase',
    'candidate.statusModel',
    'candidate.statusEffort',
    'candidate.dryRun',
    'candidate.preparedBase',
    'candidate.finalHead',
    'candidate.finalBase',
    ...(!options.candidateLive ? ['candidate.discussionUnchanged'] : []),
    ...(options.publishControl
      ? [
          'pair.initialSnapshot',
          'control.creationOutputMode',
          'control.statusIdentity',
          'control.outputMode',
          'control.model',
          'control.effort',
          'control.observedModel',
          'control.headSha',
          'control.analyticsAtDispatch',
          'control.dispatchDiagnostic',
          'control.settingsHash',
          'control.contextHash',
          'control.authoritativeSkillCaptured',
          'control.baseTipSha',
          'control.mergeBaseSha',
          'control.frozenDiscussion',
          'control.finalHead',
          'control.finalBase',
        ]
      : []),
  ])
    manifest.checks[name] = 'pending';
  deps.write('preflight.json', {
    pairId: manifest.pairId,
    options: {
      ...options,
      instructions: options.instructions
        ? { additiveInstructionsHash: hashText(options.instructions) }
        : null,
    },
    networkEnabled: options.run,
  });
  if (!options.run) {
    deps.write('comparison.json', manifest);
    return manifest;
  }
  const now = () => new Date(deps.now()).toISOString();
  const route = options.organizationId ? 'organizations.reviewAgent' : 'personalReviewAgent';
  const scope = options.organizationId ? { organizationId: options.organizationId } : {};
  const candidate = manifest.arms[0];
  const control = manifest.arms[1];
  const check = (name: string, result: Match) => {
    manifest.checks[name] = combineMatches([
      ...(manifest.checks[name] === 'mismatched' ? ['mismatched' as const] : []),
      result,
    ]);
  };

  async function execute(arm: RunArm, input: Record<string, unknown>) {
    const isCandidate = arm.arm === 'candidate';
    arm.attempted = true;
    arm.accepted = null;
    arm.status = 'creation-uncertain';
    arm.timing.requestStartedAt = now();
    deps.write(`${arm.arm}-request.json`, { at: arm.timing.requestStartedAt, input });
    try {
      const created = await deps.call(
        'POST',
        `${route}.${isCandidate ? 'createIsolateReview' : 'createManualReviewJob'}`,
        input
      );
      deps.write(`${arm.arm}-creation.json`, { observedAt: now(), response: created });
      arm.id = isCandidate
        ? z.object({ runId: z.uuid() }).parse(created).runId
        : z.object({ reviewId: z.uuid() }).parse(created).reviewId;
      arm.accepted = true;
      arm.status = 'accepted';
      arm.timing.acceptedObservedAt = now();
      if (isCandidate) {
        arm.rootSessionIds = [arm.id];
        const result = z.object({ preparation: Preparation, inference: JsonRecord }).parse(created);
        manifest.preparation = result.preparation;
        manifest.inference = result.inference;
        check(
          'candidate.preparedHead',
          compareValue(options.expectedHeadSha, result.preparation.snapshot.headSha)
        );
        check(
          'candidate.organization',
          compareValue(options.organizationId ?? null, result.preparation.organizationId ?? null)
        );
        check(
          'candidate.inferenceModel',
          compareValue(result.preparation.settings.model, result.inference.modelId)
        );
        check(
          'candidate.inferenceEffort',
          compareValue(result.preparation.settings.thinkingEffort, result.inference.thinkingEffort)
        );
        if (options.model) {
          check(
            'candidate.explicitModel',
            compareValue(options.model, result.preparation.settings.model)
          );
          check(
            'candidate.explicitEffort',
            compareValue(options.thinkingEffort ?? null, result.preparation.settings.thinkingEffort)
          );
        }
      } else {
        check(
          'control.creationOutputMode',
          compareValue('provider', JsonRecord.parse(created).outputMode)
        );
      }
      const readInput = isCandidate ? { ...scope, runId: arm.id } : { reviewId: arm.id };
      const deadline = deps.now() + TIMEOUT_MS;
      while (deps.now() < deadline) {
        const result = JsonRecord.parse(
          await deps.call(
            'GET',
            isCandidate ? `${route}.getIsolateReview` : 'codeReviews.get',
            readInput
          )
        );
        const status = isCandidate ? result : JsonRecord.parse(result.review);
        const state = z.string().parse(status.status);
        const observedAt = now();
        arm.statusEvidence = result;
        arm.coverage = {
          ...arm.coverage,
          analysis: isCandidate
            ? (status.analysisOutcome ?? 'unknown')
            : 'Backend status only; investigation completeness unmeasured',
          publication: isCandidate
            ? (status.publicationOutcome ?? 'unknown')
            : 'Unknown; completed does not prove all intended findings were published',
          terminationReason: status.terminationReason ?? status.terminal_reason ?? 'unknown',
          limitations: status.limitations ?? [],
          sessionMapping: 'known IDs only; completeness unproven',
        };
        arm.status = state;
        arm.observations.push({ at: observedAt, status: state });
        deps.write(`${arm.arm}-poll-${arm.observations.length}.json`, {
          observedAt,
          response: result,
        });
        if (isCandidate) {
          check('candidate.statusIdentity', compareValue(arm.id, status.runId));
          check('candidate.statusHead', compareValue(options.expectedHeadSha, status.headSha));
          check(
            'candidate.statusBaseTip',
            compareValue(manifest.preparation?.snapshot.baseTipSha, status.baseTipSha)
          );
          check(
            'candidate.statusMergeBase',
            compareValue(manifest.preparation?.snapshot.mergeBaseSha, status.mergeBaseSha)
          );
          check(
            'candidate.statusModel',
            compareValue(manifest.preparation?.settings.model, status.requestedModel)
          );
          const inference = JsonRecord.safeParse(status.inference).data;
          check(
            'candidate.statusEffort',
            compareValue(manifest.preparation?.settings.thinkingEffort, inference?.thinkingEffort)
          );
          check('candidate.dryRun', compareValue(!options.candidateLive, status.dryRun));
          if (!options.candidateLive && status.published === true) {
            arm.publication = 'partial';
            check('candidate.noPublication', 'mismatched');
          }
          const sessions = z.array(Id).optional().parse(status.usageSessions) ?? [];
          arm.childSessionIds = [
            ...new Set([...arm.childSessionIds, ...sessions.filter(id => id !== arm.id)]),
          ].sort();
          arm.requestIds = [
            ...new Set([
              ...arm.requestIds,
              ...(z.array(Id).optional().parse(status.requestIds) ?? []),
            ]),
          ].sort();
          if (options.candidateLive) {
            const publication = JsonRecord.safeParse(status.publicationOutcome).data;
            arm.publication =
              publication?.summary === 'confirmed' &&
              ['confirmed', 'not_requested'].includes(
                z.string().catch('').parse(publication.review)
              )
                ? 'confirmed'
                : publication?.review === 'uncertain' || publication?.summary === 'uncertain'
                  ? 'uncertain'
                  : status.published === true
                    ? 'partial'
                    : 'not-published';
          }
        } else {
          check('control.statusIdentity', compareValue(arm.id, status.id));
          const attempts = z.array(JsonRecord).parse(result.attempts);
          arm.rootSessionIds = [
            ...new Set([
              ...arm.rootSessionIds,
              ...[status, ...attempts].flatMap(entry =>
                typeof entry.cli_session_id === 'string' && entry.cli_session_id !== arm.id
                  ? [entry.cli_session_id]
                  : []
              ),
            ]),
          ].sort();
          if (manifest.preparation) {
            const verified = verifyControl(manifest.preparation, result);
            for (const [name, value] of Object.entries(verified.checks))
              check(`control.${name}`, value);
          }
        }
        const terminal = ['completed', 'error', 'failed', 'cancelled', 'interrupted'].includes(
          state
        );
        if (terminal) arm.timing.terminalObservedAt = observedAt;
        updateTiming(arm, status, observedAt);
        if (terminal) {
          arm.completed =
            state === 'completed' &&
            (!isCandidate ||
              JsonRecord.safeParse(status.analysisOutcome).data?.status === 'completed');
          break;
        }
        await deps.sleep(POLL_MS);
      }
      if (!arm.timing.terminalObservedAt) {
        arm.status = 'poll-timeout';
        throw new Error(
          'Polling timed out; execution may still be running. No further arm is started'
        );
      }
    } catch (error) {
      arm.error = safeError(error);
      throw error;
    } finally {
      if (arm.id) {
        try {
          const transcript = await deps.call(
            'GET',
            isCandidate ? `${route}.getIsolateReviewTranscript` : 'codeReviews.getSessionMessages',
            isCandidate ? { ...scope, runId: arm.id } : { reviewId: arm.id }
          );
          deps.write(`${arm.arm}-transcript.json`, { observedAt: now(), response: transcript });
          const data = JsonRecord.parse(transcript);
          arm.coverage.transcript = isCandidate
            ? 'captured'
            : 'captured-formatted-log; may be incomplete or empty';
          arm.coverage.toolCallCount =
            isCandidate && Array.isArray(data.toolCalls) ? data.toolCalls.length : null;
        } catch {
          arm.coverage.transcript = 'unavailable';
          deps.write(`${arm.arm}-transcript-unavailable.json`, {
            observedAt: now(),
            reason: 'Read failed; transcript coverage is unknown',
          });
        }
      }
      arm.timing.finalObservedAt = now();
      arm.timing.observedEndToEndMs = duration(
        arm.timing.requestStartedAt,
        arm.timing.finalObservedAt
      );
      deps.write(`${arm.arm}-outcome.json`, arm);
    }
  }

  try {
    const initial = Snapshot.parse(await deps.snapshot(options.candidateUrl));
    deps.write('candidate-initial-discussion.json', {
      observedAt: now(),
      snapshot: initial,
      hash: snapshotHash(initial),
    });
    if (initial.headSha !== options.expectedHeadSha || initial.state !== 'open' || initial.draft)
      throw new Error('Candidate PR must be open, non-draft and at the expected head');
    if (options.candidateLive && !emptyDiscussion(initial) && !options.previousRunId)
      throw new Error(
        'Candidate live requires empty discussion or --previous-run-id ownership proof'
      );
    let controlInitial: Snapshot | undefined;
    if (control && options.controlUrl) {
      controlInitial =
        options.controlUrl === options.candidateUrl
          ? initial
          : Snapshot.parse(await deps.snapshot(options.controlUrl));
      deps.write('control-initial-discussion.json', {
        observedAt: now(),
        snapshot: controlInitial,
        hash: snapshotHash(controlInitial),
      });
      if (!emptyDiscussion(controlInitial))
        throw new Error(
          'Control publication is restricted to pristine disposable PRs; existing discussion/evidence is never overwritten'
        );
      if (
        controlInitial.headSha !== initial.headSha ||
        controlInitial.baseTipSha !== initial.baseTipSha ||
        controlInitial.title !== initial.title ||
        controlInitial.body !== initial.body ||
        controlInitial.state !== 'open' ||
        controlInitial.draft ||
        !emptyDiscussion(initial)
      )
        throw new Error(
          'Pair requires equivalent commits, title/body and empty initial discussion'
        );
      check('pair.initialSnapshot', 'matched');
    }
    await execute(candidate, {
      ...scope,
      url: options.candidateUrl,
      expectedHeadSha: options.expectedHeadSha,
      ...(options.model
        ? { modelSlug: options.model, thinkingEffort: options.thinkingEffort ?? null }
        : {}),
      ...(options.instructions ? { instructions: options.instructions } : {}),
      ...(options.previousRunId ? { previousRunId: options.previousRunId } : {}),
      dryRun: !options.candidateLive,
    });
    if (
      !options.candidateLive &&
      (candidate.publication !== 'dry-run' || manifest.checks['candidate.dryRun'] === 'mismatched')
    )
      throw new Error(
        'Candidate did not remain a non-publishing dry-run; control publication refused'
      );
    const after = Snapshot.parse(await deps.snapshot(options.candidateUrl));
    deps.write('candidate-final-discussion.json', {
      observedAt: now(),
      snapshot: after,
      hash: snapshotHash(after),
    });
    check(
      'candidate.preparedBase',
      compareValue(initial.baseTipSha, manifest.preparation?.snapshot.baseTipSha)
    );
    check('candidate.finalHead', compareValue(initial.headSha, after.headSha));
    check('candidate.finalBase', compareValue(initial.baseTipSha, after.baseTipSha));
    if (initial.headSha !== after.headSha || initial.baseTipSha !== after.baseTipSha)
      throw new Error('Candidate PR commits changed; control publication refused');
    if (!options.candidateLive) {
      check(
        'candidate.discussionUnchanged',
        compareValue(snapshotHash(initial), snapshotHash(after))
      );
      if (snapshotHash(initial) !== snapshotHash(after))
        throw new Error('Candidate dry-run discussion changed; control publication refused');
    }
    if (control && options.controlUrl && controlInitial && manifest.preparation) {
      const frozen = Snapshot.parse(await deps.snapshot(options.controlUrl));
      deps.write('control-predispatch-discussion.json', {
        observedAt: now(),
        snapshot: frozen,
        hash: snapshotHash(frozen),
      });
      check(
        'control.frozenDiscussion',
        compareValue(snapshotHash(controlInitial), snapshotHash(frozen))
      );
      if (snapshotHash(controlInitial) !== snapshotHash(frozen))
        throw new Error('Control PR changed before dispatch; publication refused');
      await execute(control, {
        ...scope,
        platform: 'github',
        url: options.controlUrl,
        modelSlug: manifest.preparation.settings.model,
        thinkingEffort: manifest.preparation.settings.thinkingEffort,
        ...(options.instructions ? { instructions: options.instructions } : {}),
      });
      const final = Snapshot.parse(await deps.snapshot(options.controlUrl));
      deps.write('control-final-discussion.json', { observedAt: now(), snapshot: final });
      check('control.finalHead', compareValue(controlInitial.headSha, final.headSha));
      check('control.finalBase', compareValue(controlInitial.baseTipSha, final.baseTipSha));
    }
  } catch (error) {
    manifest.errors.push(safeError(error));
  } finally {
    for (const arm of manifest.arms) {
      arm.inputMatch = combineMatches(
        Object.entries(manifest.checks)
          .filter(([key]) => key.startsWith(`${arm.arm}.`) || key.startsWith('pair.'))
          .map(([, value]) => value)
      );
    }
    deps.write('comparison.json', manifest);
    deps.write('report.json', buildReport(manifest));
  }
  return manifest;
}

export function buildReport(manifest: Comparison, ledger?: Ledger) {
  if (ledger && ledger.pairId !== manifest.pairId)
    throw new Error('Finding ledger belongs to a different pair');
  const matched =
    manifest.arms.length === 2 &&
    manifest.arms.every(arm => arm.accepted === true) &&
    combineMatches(manifest.arms.map(arm => arm.inputMatch)) === 'matched';
  const findings = ledger ? manifest.arms.flatMap(arm => ledger.findings[arm.arm]) : [];
  return {
    pairId: manifest.pairId,
    comparisonKind: manifest.preparation?.settings.model.startsWith('kilo-auto/')
      ? 'end-to-end-auto-alias'
      : 'concrete-model-end-to-end; engine-only protocol/context parity not established',
    matchedQualityEligible: matched,
    conditionalCompletedQualityEligible: matched && manifest.arms.every(arm => arm.completed),
    checks: manifest.checks,
    overall: aggregateArms(manifest.arms, findings),
    arms: manifest.arms.map(arm => ({
      ...arm,
      summary: aggregateArms([arm], ledger?.findings[arm.arm] ?? []),
      quality: ledger ? findingQuality(ledger.findings[arm.arm], ledger.expectedDefects) : null,
      summaryAccuracy: ledger?.summaryAccuracy[arm.arm] ?? 'unreviewed',
    })),
    limitations: manifest.limitations,
    errors: manifest.errors,
    qualitySource: ledger?.source ?? 'No external labels; no automatic quality scoring',
    qualityScope:
      'Per-arm labels remain visible on failed/mismatched arms; only eligible pairs support matched comparisons. Proposed and published denominators are separate.',
  };
}

const HELP = `Usage: pnpm exec tsx services/isolate-review/scripts/compare-reviews.ts
  --candidate-url URL --expected-head-sha SHA --web-url http://127.0.0.1:PORT --out NEW_DIRECTORY
  [--model kilo-auto/efficient] [--thinking-effort KEY] [--instructions-file PRIVATE_FILE]
  [--organization-id UUID] [--previous-run-id UUID]
  [--run] [--candidate-live] [--control-url URL --publish-control --confirm-provider-mode]
  [--confirm-disposable-prs]
Default: offline CLI preflight, no HTTP, gh, inference or publication.
--run: candidate first, dry-run unless --candidate-live; dry-run still spends credits.
Control has NO dryRun: --publish-control authorizes provider writes. DEBUG_SHOW_DEV_UI must be empty.
Live pairs require independent pristine disposable PRs; PRs na2-org/hi-how-are-you#8/#9/#10 are write-protected.
No PR creation, POST retries, credit top-ups, service management or deployments.
KILO_TOKEN stays in the environment. gh must already have read access; only GETs are used.
Offline report: --report PRIVATE_COMPARISON_JSON --out NEW_DIRECTORY
  [--ledger PRIVATE_LABELS_JSON] [--control-diagnostic PRIVATE_DIAGNOSTIC_JSON]
  [--candidate-usage PRIVATE_USAGE_JSON] [--control-usage PRIVATE_USAGE_JSON]
Report inputs are raw JSON except comparison.json, which is a versioned runner artifact.
Artifacts: new directory 0700, files 0600, never overwrite existing evidence.`;

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      'candidate-url': { type: 'string' },
      'control-url': { type: 'string' },
      'expected-head-sha': { type: 'string' },
      'web-url': { type: 'string' },
      out: { type: 'string' },
      model: { type: 'string' },
      'thinking-effort': { type: 'string' },
      'instructions-file': { type: 'string' },
      'organization-id': { type: 'string' },
      'previous-run-id': { type: 'string' },
      run: { type: 'boolean' },
      'candidate-live': { type: 'boolean' },
      'publish-control': { type: 'boolean' },
      'confirm-provider-mode': { type: 'boolean' },
      'confirm-disposable-prs': { type: 'boolean' },
      report: { type: 'string' },
      ledger: { type: 'string' },
      'control-diagnostic': { type: 'string' },
      'candidate-usage': { type: 'string' },
      'control-usage': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const output = resolve(z.string().min(1).parse(values.out));
  const secrets = [
    process.env.KILO_TOKEN ?? '',
    process.env.GH_TOKEN ?? '',
    process.env.GITHUB_TOKEN ?? '',
  ];
  if (values.report) {
    if (values.run || values['publish-control'] || values['candidate-live'])
      throw new Error('Offline reporting cannot start reviews');
    const manifest = Comparison.parse(unwrapArtifact(readPrivateJson(values.report)));
    const control = manifest.arms.find(arm => arm.arm === 'control');
    if (values['control-diagnostic']) {
      const diagnostic = ControlDiagnostic.parse(readPrivateJson(values['control-diagnostic']));
      if (!control?.statusEvidence || !manifest.preparation)
        throw new Error('Captured control status and candidate preparation are required');
      const checked = verifyControl(manifest.preparation, control.statusEvidence, diagnostic);
      const mapped = addKnownControlChildren(control, diagnostic);
      Object.assign(control, mapped);
      for (const [key, result] of Object.entries(checked.checks))
        manifest.checks[`control.${key}`] =
          manifest.checks[`control.${key}`] === 'mismatched' ? 'mismatched' : result;
      control.inputMatch = combineMatches(
        Object.entries(manifest.checks)
          .filter(([key]) => key.startsWith('control.') || key.startsWith('pair.'))
          .map(([, result]) => result)
      );
    }
    const ledger = values.ledger ? Ledger.parse(readPrivateJson(values.ledger)) : undefined;
    for (const arm of manifest.arms) {
      const path = arm.arm === 'candidate' ? values['candidate-usage'] : values['control-usage'];
      if (path) {
        if (!manifest.preparation)
          throw new Error('Preparation execution identity required for cost attribution');
        arm.cost = usageCost(readPrivateJson(path), arm, manifest.preparation.executionUserId);
      }
    }
    const allSessions = manifest.arms.flatMap(arm => [
      ...arm.rootSessionIds,
      ...arm.childSessionIds,
    ]);
    if (new Set(allSessions).size !== allSessions.length)
      throw new Error('Overlapping arm sessions cannot be double-counted');
    const report = buildReport(manifest, ledger);
    const write = createPrivateArtifacts(output, secrets);
    write('comparison.json', manifest);
    write('report.json', report);
    for (const key of [
      'ledger',
      'control-diagnostic',
      'candidate-usage',
      'control-usage',
    ] as const) {
      const path = values[key];
      if (path) write(`${key}.json`, readPrivateJson(path));
    }
  } else {
    if (
      values.ledger ||
      values['control-diagnostic'] ||
      values['candidate-usage'] ||
      values['control-usage']
    )
      throw new Error('Labels/diagnostics/usage are report-only and are never sent to a reviewer');
    let debug = process.env.DEBUG_SHOW_DEV_UI;
    if (values['publish-control']) {
      try {
        const env = parseEnv(readFileSync(new URL('../../../.env.local', import.meta.url), 'utf8'));
        debug ||= env.DEBUG_SHOW_DEV_UI;
      } catch {
        debug ||= undefined;
      }
    }
    const options = validateOptions(
      Options.parse({
        candidateUrl: values['candidate-url'],
        controlUrl: values['control-url'],
        expectedHeadSha: values['expected-head-sha'],
        webUrl: values['web-url'],
        out: output,
        model: values.model,
        thinkingEffort: values['thinking-effort'],
        instructions: values['instructions-file']
          ? readPrivateText(values['instructions-file'])
          : undefined,
        organizationId: values['organization-id'],
        previousRunId: values['previous-run-id'],
        run: values.run ?? false,
        candidateLive: values['candidate-live'] ?? false,
        publishControl: values['publish-control'] ?? false,
        confirmProviderMode: values['confirm-provider-mode'] ?? false,
        confirmDisposablePrs: values['confirm-disposable-prs'] ?? false,
      }),
      debug
    );
    const token = process.env.KILO_TOKEN?.trim();
    if (options.run && !token) throw new Error('KILO_TOKEN is required for --run');
    const write = createPrivateArtifacts(output, secrets);
    const manifest = await runComparison(options, {
      call: createReviewApi(options.webUrl, token ?? ''),
      snapshot: githubSnapshot,
      write,
      now: Date.now,
      sleep: setTimeout,
    });
    if (
      manifest.errors.length ||
      manifest.arms.some(
        arm => arm.attempted && (!arm.completed || arm.inputMatch === 'mismatched')
      )
    )
      process.exitCode = 1;
  }
  console.log(`Private artifacts: ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => {
    console.error(
      redactArtifact(safeError(error), [
        process.env.KILO_TOKEN ?? '',
        process.env.GH_TOKEN ?? '',
        process.env.GITHUB_TOKEN ?? '',
      ])
    );
    process.exitCode = 1;
  });
}
