// Fetch prebuilt native artifacts from the `mobile-native-build` GitHub
// workflow so a host installs a cached binary instead of compiling one.
// The artifact is keyed by the platform's input-deterministic nativeHash
// (see buildFingerprintOptions / buildAndroidFingerprintOptions), so any
// machine that computes the same hash can reuse the same binary.
//
// Every failure path returns false/undefined so the caller falls back to
// the local build — the failure path stays today's path. Set
// KILO_REMOTE_NATIVE=off to skip remote fetching entirely, or
// KILO_REMOTE_NATIVE=required to fail the build instead of compiling locally.
//
// Before dispatching a new build, an existing canonical run proven to be
// producing the same platform's artifact for the exact pushed commit is
// joined and watched. Its artifact is trusted only through
// findNativeArtifacts after the run succeeds, so joining never weakens
// provenance checks.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

const WORKFLOW_FILE = 'mobile-native-build.yml';
// A queued + running macOS build fits well inside this; a hung run must not
// pin an agent forever, so time out and build locally.
const WATCH_TIMEOUT_MS = 45 * 60 * 1000;
const GH_TIMEOUT_MS = 60 * 1000;
// A failed lookup does not prove that no producer exists.
// Retry reads before stopping without a duplicate dispatch.
const PRODUCER_LOOKUP_ATTEMPTS = 3;
const PRODUCER_LOOKUP_RETRY_MS = 1000;
// Artifact zips run to a few hundred MB.
const DOWNLOAD_MAX_BUFFER = 2 * 1024 * 1024 * 1024;

export function remoteNativeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KILO_REMOTE_NATIVE === 'off';
}

export function remoteNativeRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KILO_REMOTE_NATIVE === 'required';
}

export function artifactName(platform: 'ios' | 'android', nativeHash: string): string {
  return `mobile-native-${platform}-${nativeHash}`;
}

function log(message: string): void {
  process.stderr.write(`mobile-remote-native: ${message}\n`);
}

function gh(args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout ?? GH_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
  });
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

export type NativeArtifact = {
  id: number;
  name: string;
  created_at: string;
  expires_at: string;
};

type ArtifactMetadata = Partial<NativeArtifact> & {
  expired?: boolean;
  workflow_run?: {
    id?: number;
    repository_id?: number;
    head_repository_id?: number;
    head_sha?: string;
  };
};

type RepositoryMetadata = { id?: number; default_branch?: string };
type WorkflowMetadata = { id?: number; path?: string; state?: string };
type RunMetadata = {
  id?: number;
  workflow_id?: number;
  path?: string;
  event?: string;
  status?: string;
  conclusion?: string;
  head_sha?: string;
  head_branch?: string;
  repository?: { id?: number };
  head_repository?: { id?: number };
  pull_requests?: {
    number?: number;
    head?: { repo?: { id?: number } };
    base?: { repo?: { id?: number } };
  }[];
};

type VerifiedNativeSource = {
  base: string;
  repoId: number;
  defaultBranch: string;
  workflowId: number;
  workflowPath: string;
};

// The canonical repository and workflow every trusted run or artifact must
// belong to. Throws when either cannot be verified.
function verifiedNativeSource(repository: string): VerifiedNativeSource {
  const base = `repos/${repository}`;
  const repo = JSON.parse(gh(['api', base])) as RepositoryMetadata | null;
  const workflowPath = `.github/workflows/${WORKFLOW_FILE}`;
  const workflow = JSON.parse(
    gh(['api', `${base}/actions/workflows/${WORKFLOW_FILE}`])
  ) as WorkflowMetadata | null;
  const repoId = repo?.id;
  const defaultBranch = repo?.default_branch;
  const workflowId = workflow?.id;
  if (
    typeof repoId !== 'number' ||
    !Number.isSafeInteger(repoId) ||
    repoId <= 0 ||
    typeof defaultBranch !== 'string' ||
    defaultBranch.length === 0 ||
    typeof workflowId !== 'number' ||
    !Number.isSafeInteger(workflowId) ||
    workflowId <= 0 ||
    workflow?.path !== workflowPath ||
    workflow?.state !== 'active'
  ) {
    throw new Error('Native artifact source could not be verified');
  }
  return { base, repoId, defaultBranch, workflowId, workflowPath };
}

export function findNativeArtifacts(
  name: string,
  repository = '{owner}/{repo}',
  expectedHeadSha: string | undefined = git(['rev-parse', 'HEAD']),
  validationScope?: { pullRequestNumber: number; headRepositoryId: number }
): NativeArtifact[] {
  const verified = verifiedNativeSource(repository);
  const { base, workflowPath } = verified;
  const repo = { id: verified.repoId, default_branch: verified.defaultBranch };
  const workflow = { id: verified.workflowId };
  const listing = JSON.parse(
    gh(['api', `${base}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`])
  ) as { artifacts?: (ArtifactMetadata | null)[] } | null;
  if (!Array.isArray(listing?.artifacts)) throw new Error('Invalid native artifact listing');
  const trusted: NativeArtifact[] = [];
  for (const artifact of listing.artifacts) {
    if (
      typeof artifact?.id !== 'number' ||
      !Number.isSafeInteger(artifact.id) ||
      artifact.id <= 0 ||
      artifact.name !== name ||
      artifact.expired !== false ||
      typeof artifact.created_at !== 'string' ||
      !Number.isFinite(Date.parse(artifact.created_at)) ||
      typeof artifact.expires_at !== 'string' ||
      Date.parse(artifact.expires_at) <= Date.now() ||
      !Number.isFinite(Date.parse(artifact.expires_at))
    ) {
      continue;
    }
    const source = artifact.workflow_run;
    if (
      typeof source?.id !== 'number' ||
      !Number.isSafeInteger(source.id) ||
      source.id <= 0 ||
      source.repository_id !== repo.id ||
      typeof source.head_repository_id !== 'number' ||
      !Number.isSafeInteger(source.head_repository_id) ||
      source.head_repository_id <= 0 ||
      (source.head_repository_id !== repo.id &&
        source.head_repository_id !== validationScope?.headRepositoryId) ||
      typeof source.head_sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(source.head_sha)
    ) {
      continue;
    }
    const run = JSON.parse(gh(['api', `${base}/actions/runs/${source.id}`])) as RunMetadata | null;
    if (
      run?.id !== source.id ||
      run.workflow_id !== workflow.id ||
      run.path !== workflowPath ||
      run.repository?.id !== repo.id ||
      run.head_repository?.id !== source.head_repository_id ||
      run.head_sha !== source.head_sha ||
      run.status !== 'completed' ||
      run.conclusion !== 'success' ||
      typeof run.head_branch !== 'string' ||
      run.head_branch.length === 0 ||
      !(
        (source.head_repository_id === repo.id &&
          ((run.event === 'workflow_dispatch' && run.head_sha === expectedHeadSha) ||
            (run.event === 'push' && run.head_branch === repo.default_branch))) ||
        (validationScope !== undefined &&
          run.event === 'pull_request' &&
          source.head_repository_id === validationScope.headRepositoryId &&
          Array.isArray(run.pull_requests) &&
          run.pull_requests.some(
            request =>
              request?.number === validationScope.pullRequestNumber &&
              request.head?.repo?.id === validationScope.headRepositoryId &&
              request.base?.repo?.id === repo.id
          ))
      )
    ) {
      continue;
    }
    trusted.push({
      id: artifact.id,
      name,
      created_at: artifact.created_at,
      expires_at: artifact.expires_at,
    });
  }
  return trusted;
}

export type NativeProducerRun = {
  id: number;
  workflowId: number;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  headBranch: string;
  repositoryId: number;
  headRepositoryId: number;
};

const PositiveIdSchema = z
  .number()
  .int()
  .positive()
  .refine(value => Number.isSafeInteger(value));

const ProducerRunApiSchema = z.object({
  id: PositiveIdSchema,
  workflow_id: PositiveIdSchema,
  path: z.string().min(1),
  event: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable().optional(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  head_branch: z.string().min(1),
  repository: z.object({ id: PositiveIdSchema }),
  head_repository: z.object({ id: PositiveIdSchema }),
});

const ProducerRunListingSchema = z.object({
  workflow_runs: z.array(z.unknown()),
});

function toNativeProducerRun(input: z.infer<typeof ProducerRunApiSchema>): NativeProducerRun {
  return {
    id: input.id,
    workflowId: input.workflow_id,
    path: input.path,
    event: input.event,
    status: input.status,
    conclusion: input.conclusion ?? null,
    headSha: input.head_sha,
    headBranch: input.head_branch,
    repositoryId: input.repository.id,
    headRepositoryId: input.head_repository.id,
  };
}

// Parse a workflow-runs listing. Every entry must verify: a malformed
// entry is unknown producer evidence, not proof that no producer exists,
// so it fails the lookup instead of being silently dropped.
export function parseNativeProducerRuns(input: unknown): NativeProducerRun[] {
  const listing = ProducerRunListingSchema.safeParse(input);
  if (!listing.success) throw new Error('Invalid native producer listing');
  return listing.data.workflow_runs.map(item => {
    const run = ProducerRunApiSchema.safeParse(item);
    if (!run.success) throw new Error('Invalid native producer listing');
    return toNativeProducerRun(run.data);
  });
}

// Parse one run detail. Malformed detail is unknown evidence, never proof
// that the producer is absent.
function parseNativeProducerRun(input: unknown): NativeProducerRun {
  const run = ProducerRunApiSchema.safeParse(input);
  if (!run.success) throw new Error('Invalid native producer run');
  return toNativeProducerRun(run.data);
}

export type NativeProducerJob = {
  name: string;
  status: string;
  conclusion: string | null;
};

const ProducerJobApiSchema = z.object({
  id: PositiveIdSchema,
  run_id: PositiveIdSchema,
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable().optional(),
});

const ProducerJobListingSchema = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(z.unknown()),
});

// Parse a run-jobs listing for one run. The workflow has three jobs, so a
// listing whose count disagrees with its entries, or that carries another
// run's jobs, is incomplete evidence and fails closed.
export function parseNativeProducerJobs(input: unknown, runId: number): NativeProducerJob[] {
  const listing = ProducerJobListingSchema.safeParse(input);
  if (!listing.success || listing.data.total_count !== listing.data.jobs.length) {
    throw new Error('Invalid native producer jobs listing');
  }
  return listing.data.jobs.map(item => {
    const job = ProducerJobApiSchema.safeParse(item);
    if (!job.success || job.data.run_id !== runId) {
      throw new Error('Invalid native producer jobs listing');
    }
    return {
      name: job.data.name,
      status: job.data.status,
      conclusion: job.data.conclusion ?? null,
    };
  });
}

// Non-terminal run statuses a watcher can still join.
const ACTIVE_PRODUCER_STATUSES = new Set([
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
]);

export type CompatibleProducerExpected = {
  repositoryId: number;
  workflowId: number;
  workflowPath: string;
  headSha: string;
  branch: string;
  defaultBranch: string;
};

function isCompatibleProducer(
  run: NativeProducerRun,
  expected: CompatibleProducerExpected
): boolean {
  return (
    run.workflowId === expected.workflowId &&
    run.path === expected.workflowPath &&
    run.repositoryId === expected.repositoryId &&
    // Same-repository heads only: a fork run is never an install source,
    // matching findNativeArtifacts without a pull-request validation scope.
    run.headRepositoryId === expected.repositoryId &&
    // The exact pushed commit, so the run's tree — and therefore its
    // nativeHash and artifact name — equals the one this host computed.
    run.headSha === expected.headSha &&
    ((run.event === 'workflow_dispatch' && run.headBranch === expected.branch) ||
      (run.event === 'push' && run.headBranch === expected.defaultBranch))
  );
}

export type ProducerPlatformEvidence = 'compatible' | 'incompatible' | 'unknown';

// Does this run produce `platform`? A push run is known all-platform: the
// workflow gates on PLATFORM `inputs.platform || 'all'` and a push carries
// no inputs. A manual dispatch's platform input is not exposed, so only
// its jobs prove it — the workflow's jobs are named for their job ids
// (`gate`, `ios`, `android`). A live or finished non-skipped platform job
// is positive proof; a skipped one proves the run will not produce that
// platform. No platform job yet — a queued run whose gate has not decided
// — is unknown, never assumed compatible.
export function producerPlatformEvidence(
  run: NativeProducerRun,
  jobs: readonly NativeProducerJob[],
  platform: 'ios' | 'android'
): ProducerPlatformEvidence {
  if (run.event === 'push') return 'compatible';
  const platformJobs = jobs.filter(job => job.name === platform);
  if (platformJobs.length !== 1) return 'unknown';
  const job = platformJobs[0] as NativeProducerJob;
  if (ACTIVE_PRODUCER_STATUSES.has(job.status)) return 'compatible';
  if (job.status === 'completed') {
    return job.conclusion === 'skipped' ? 'incompatible' : 'compatible';
  }
  return 'unknown';
}

export type ProducerSelection =
  | { kind: 'producer'; run: NativeProducerRun }
  | { kind: 'absent' }
  | { kind: 'unknown' };

// Order the runs worth joining: identity-compatible active runs newest
// first (list order), then identity-compatible runs that just succeeded.
// A failed or cancelled producer is never a candidate, so it can neither
// be joined nor shadow one behind it.
function producerCandidates(
  runs: readonly NativeProducerRun[],
  expected: CompatibleProducerExpected
): NativeProducerRun[] {
  const compatible = runs.filter(run => isCompatibleProducer(run, expected));
  return [
    ...compatible.filter(run => ACTIVE_PRODUCER_STATUSES.has(run.status)),
    ...compatible.filter(run => run.status === 'completed' && run.conclusion === 'success'),
  ];
}

// Select the first candidate with proven platform compatibility. A
// candidate proven to build another platform does not shadow a compatible
// one behind it. When none is proven but some candidate's platform is
// unknown, the result is 'unknown', not 'absent': dispatching on unknown
// evidence can duplicate a run that is already producing the artifact.
// The evidence callback may throw on unverifiable metadata, which fails
// the lookup the same way.
export function selectCompatibleProducer(
  runs: readonly NativeProducerRun[],
  expected: CompatibleProducerExpected,
  platformEvidence: (run: NativeProducerRun) => ProducerPlatformEvidence
): ProducerSelection {
  let sawUnknown = false;
  for (const run of producerCandidates(runs, expected)) {
    const evidence = platformEvidence(run);
    if (evidence === 'compatible') return { kind: 'producer', run };
    if (evidence === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? { kind: 'unknown' } : { kind: 'absent' };
}

function fetchProducerJobs(base: string, runId: number): NativeProducerJob[] {
  return parseNativeProducerJobs(
    JSON.parse(gh(['api', `${base}/actions/runs/${runId}/jobs?per_page=100`])),
    runId
  );
}

// Find a canonical queued, running, or just-finished producer of this
// platform for the exact pushed commit. The picked run is re-fetched and
// re-evaluated; a run that turned terminal-failed is dropped and the
// remaining listed candidates are re-evaluated before the producer is
// declared absent. Unverifiable listing, detail, or jobs data throws —
// unknown evidence must never read as absence. Returns undefined only
// when every candidate is proven unusable for this platform.
export function findNativeProducer(
  args: { platform: 'ios' | 'android'; branch: string; headSha: string },
  repository = '{owner}/{repo}'
): NativeProducerRun | undefined {
  const verified = verifiedNativeSource(repository);
  const expected: CompatibleProducerExpected = {
    repositoryId: verified.repoId,
    workflowId: verified.workflowId,
    workflowPath: verified.workflowPath,
    headSha: args.headSha,
    branch: args.branch,
    defaultBranch: verified.defaultBranch,
  };
  const listing: unknown = JSON.parse(
    gh([
      'api',
      `${verified.base}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${encodeURIComponent(args.headSha)}&per_page=30`,
    ])
  );
  const listed = parseNativeProducerRuns(listing);
  // Jobs are fetched lazily per candidate and cached for one lookup; a
  // refreshed candidate is re-checked against fresh jobs below.
  const evidenceCache = new Map<number, ProducerPlatformEvidence>();
  const evidence = (run: NativeProducerRun, fresh = false): ProducerPlatformEvidence => {
    const cached = evidenceCache.get(run.id);
    if (!fresh && cached !== undefined) return cached;
    const value =
      run.event === 'push'
        ? producerPlatformEvidence(run, [], args.platform)
        : producerPlatformEvidence(run, fetchProducerJobs(verified.base, run.id), args.platform);
    evidenceCache.set(run.id, value);
    return value;
  };
  const excluded = new Set<number>();
  for (;;) {
    const selection = selectCompatibleProducer(
      listed.filter(run => !excluded.has(run.id)),
      expected,
      run => evidence(run)
    );
    if (selection.kind === 'absent') return undefined;
    if (selection.kind === 'unknown') {
      throw new Error('Native producer platform could not be verified');
    }
    const picked = selection.run;
    const refreshed = parseNativeProducerRun(
      JSON.parse(gh(['api', `${verified.base}/actions/runs/${picked.id}`]))
    );
    if (refreshed.id !== picked.id) throw new Error('Invalid native producer run');
    const reselection = selectCompatibleProducer([refreshed], expected, run => evidence(run, true));
    if (reselection.kind === 'producer') return refreshed;
    if (reselection.kind === 'unknown') {
      throw new Error('Native producer platform could not be verified');
    }
    // The picked run turned terminal-failed or its platform job was
    // skipped: drop it and re-evaluate the remaining candidates.
    excluded.add(picked.id);
  }
}

// Re-read one run after a failed watch. Reads retry like the producer
// lookup; a run that stays unreadable is unknown evidence and maps to
// 'failed' in the caller, never to a duplicate dispatch.
function refreshNativeProducer(runId: number): NativeProducerRun | undefined {
  for (let attempt = 1; attempt <= PRODUCER_LOOKUP_ATTEMPTS; attempt++) {
    try {
      const run = parseNativeProducerRun(
        JSON.parse(gh(['api', `repos/{owner}/{repo}/actions/runs/${runId}`]))
      );
      if (run.id !== runId) throw new Error('Invalid native producer run');
      return run;
    } catch {
      if (attempt < PRODUCER_LOOKUP_ATTEMPTS) sleepSync(PRODUCER_LOOKUP_RETRY_MS);
    }
  }
  return undefined;
}

// Download an artifact zip and hand the caller its unpacked directory.
// Returns false when the artifact does not exist (after a dispatch attempt)
// or anything in the chain fails.
function withArtifact(
  platform: 'ios' | 'android',
  nativeHash: string,
  use: (unpackedDir: string) => void
): boolean {
  if (remoteNativeDisabled()) return false;
  const name = artifactName(platform, nativeHash);
  // No gh, no auth, or no network: local build is the fallback.
  const initial = findArtifactOrLog(name, '');
  if (initial === null) return false;
  let artifact = initial;
  if (!artifact) {
    log(`no artifact ${name}; trying a remote build`);
    const ref = currentPushedRef();
    if (!ref) return false;
    const joined = joinExistingProducer(platform, ref);
    if (joined === 'failed') return false;
    if (joined === 'reused') {
      const produced = findArtifactOrLog(name, ' after existing producer finished');
      if (produced === null) return false;
      artifact = produced;
    }
    if (!artifact) {
      // No producer, an incompatible or terminal producer, or a producer
      // that succeeded without this platform's artifact: dispatch our own.
      if (!dispatchAndWatch(platform, ref)) return false;
      const produced = findArtifactOrLog(name, ' after dispatch');
      if (produced === null) return false;
      artifact = produced;
    }
    if (!artifact) {
      // The remote run built a different hash (local uncommitted native
      // changes) or uploaded nothing.
      log(`remote build finished but produced no artifact ${name}`);
      return false;
    }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-remote-native-'));
  try {
    const zipPath = path.join(scratch, 'artifact.zip');
    const zip = execFileSync(
      'gh',
      ['api', `repos/{owner}/{repo}/actions/artifacts/${artifact.id}/zip`],
      { maxBuffer: DOWNLOAD_MAX_BUFFER, timeout: 10 * 60 * 1000 }
    );
    fs.writeFileSync(zipPath, zip);
    const unpacked = path.join(scratch, 'unpacked');
    fs.mkdirSync(unpacked);
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', unpacked], { stdio: 'ignore' });
    use(unpacked);
    log(`installed remote artifact ${name}`);
    return true;
  } catch (error) {
    log(`artifact download failed (${message(error)})`);
    return false;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// One artifact lookup with the failure logged. `null` means the lookup
// itself failed, `undefined` means no trusted artifact exists.
function findArtifactOrLog(name: string, context: string): NativeArtifact | undefined | null {
  try {
    return findNativeArtifacts(name)[0];
  } catch (error) {
    log(`artifact lookup failed${context} (${message(error)})`);
    return null;
  }
}

type PushedRef = { branch: string; headSha: string };

// Joining or dispatching a remote build is only possible when HEAD is
// exactly the pushed upstream commit — the runner builds from the remote
// ref, so anything else builds the wrong tree.
function currentPushedRef(): PushedRef | undefined {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') {
    log('detached HEAD; cannot dispatch a remote build');
    return undefined;
  }
  const head = git(['rev-parse', 'HEAD']);
  const upstream = git(['rev-parse', '@{u}']);
  if (!head || !upstream || head !== upstream) {
    log(`branch ${branch} is not pushed to its upstream; cannot dispatch a remote build`);
    return undefined;
  }
  return { branch, headSha: head };
}

const RemoteBranchTipSchema = z.object({
  ref: z.string().min(1),
  object: z.object({
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    type: z.literal('commit'),
  }),
});

// The commit an actual remote branch ref points at, from the git ref
// response. A response for another ref, a non-commit object, or any
// malformed shape is unknown evidence and throws.
export function parseRemoteBranchTip(input: unknown, branch: string): string {
  const parsed = RemoteBranchTipSchema.safeParse(input);
  if (!parsed.success || parsed.data.ref !== `refs/heads/${branch}`) {
    throw new Error('Invalid remote branch tip response');
  }
  return parsed.data.object.sha;
}

function fetchRemoteBranchTip(branch: string): string {
  return parseRemoteBranchTip(
    JSON.parse(gh(['api', `repos/{owner}/{repo}/git/ref/heads/${branch}`])),
    branch
  );
}

// The dispatch fence. The pushed-ref snapshot can be a full producer
// watch old by the time a dispatch is considered, and dispatching builds
// whatever the remote branch points at then — silently retargeting the
// build away from the commit this host computed its nativeHash from.
// Immediately before dispatch, prove the local branch, HEAD, and
// upstream still equal the snapshot and that the actual remote tip
// (read from the API, not the possibly stale tracking ref) is still the
// requested SHA. Anything moved or unverifiable stops without dispatch.
function revalidatePushedRef(ref: PushedRef): boolean {
  const current = currentPushedRef();
  if (!current) return false;
  if (current.branch !== ref.branch || current.headSha !== ref.headSha) {
    log(
      `local ref moved from ${ref.branch}@${ref.headSha} to ${current.branch}@${current.headSha} while waiting; not dispatching under the original native inputs`
    );
    return false;
  }
  for (let attempt = 1; attempt <= PRODUCER_LOOKUP_ATTEMPTS; attempt++) {
    try {
      const tip = fetchRemoteBranchTip(ref.branch);
      if (tip !== ref.headSha) {
        log(
          `remote branch ${ref.branch} is at ${tip}, not the requested ${ref.headSha}; not dispatching under the original native inputs`
        );
        return false;
      }
      return true;
    } catch (error) {
      if (attempt === PRODUCER_LOOKUP_ATTEMPTS) {
        log(`could not verify remote branch tip (${message(error)}); no run was dispatched`);
        return false;
      }
      sleepSync(PRODUCER_LOOKUP_RETRY_MS);
    }
  }
  return false;
}

function watchRun(runId: number, startedAt: number): boolean {
  try {
    execFileSync('gh', ['run', 'watch', String(runId), '--exit-status', '--interval', '30'], {
      stdio: ['ignore', process.stderr, process.stderr],
      timeout: WATCH_TIMEOUT_MS,
    });
    log(`remote build run ${runId} finished after ${waited(startedAt)}`);
    return true;
  } catch (error) {
    log(
      `remote build run ${runId} failed or timed out after ${waited(startedAt)} (${message(error)})`
    );
    return false;
  }
}

// One validated producer discovery with bounded read retries. Returns
// the producer, `undefined` when discovery proves none is usable, or
// `null` when reads stayed unverifiable — unknown evidence, never a
// reason to dispatch a duplicate.
function discoverProducer(
  platform: 'ios' | 'android',
  ref: PushedRef
): NativeProducerRun | undefined | null {
  for (let attempt = 1; attempt <= PRODUCER_LOOKUP_ATTEMPTS; attempt++) {
    try {
      return findNativeProducer({ platform, ...ref });
    } catch (error) {
      if (attempt === PRODUCER_LOOKUP_ATTEMPTS) {
        log(`existing producer lookup failed (${message(error)}); no run was dispatched`);
        return null;
      }
      sleepSync(PRODUCER_LOOKUP_RETRY_MS);
    }
  }
  return null;
}

// Join an existing compatible producer instead of dispatching a duplicate.
// 'reused' means a producer succeeded and its artifact may now be looked
// up; 'dispatch' means discovery proved no usable producer exists;
// 'failed' means a watch or a read gave up on unknown evidence. Each
// watched run is joined at most once, and no run is ever cancelled or
// otherwise mutated.
function joinExistingProducer(
  platform: 'ios' | 'android',
  ref: PushedRef
): 'reused' | 'dispatch' | 'failed' {
  const joinedRunIds = new Set<number>();
  for (;;) {
    const producer = discoverProducer(platform, ref);
    if (producer === null) return 'failed';
    if (!producer) return 'dispatch';
    if (joinedRunIds.has(producer.id)) return 'failed';
    if (producer.status === 'completed') {
      log(`existing producer run ${producer.id} already succeeded; reusing its artifact`);
      return 'reused';
    }
    joinedRunIds.add(producer.id);
    const startedAt = Date.now();
    log(
      `joining existing producer run ${producer.id} on ${producer.headBranch} at ${producer.headSha}; waiting for the run`
    );
    if (watchRun(producer.id, startedAt)) return 'reused';
    // The watch failed, which can be a watcher timeout or network error
    // after the run itself finished. A refresh that positively proves
    // completed success is reused exactly like a clean watch — the
    // caller still validates the artifact through the trusted lookup. A
    // producer proven terminal-failed or cancelled leaves no trusted
    // artifact, but another compatible producer may still be active
    // behind it: rediscover before dispatching a duplicate. A producer
    // that is still active (or stays unreadable) means the watch timed
    // out on unknown evidence: give up as a dispatched run would,
    // without dispatching.
    const refreshed = refreshNativeProducer(producer.id);
    if (refreshed?.status === 'completed' && refreshed.conclusion === 'success') {
      log(
        `existing producer run ${producer.id} succeeded despite the failed watch; reusing its artifact`
      );
      return 'reused';
    }
    if (refreshed?.status === 'completed' && refreshed.conclusion !== 'success') {
      log(
        `existing producer run ${producer.id} ended ${refreshed.conclusion ?? 'without success'}; looking for another compatible producer`
      );
      continue;
    }
    return 'failed';
  }
}

type DispatchRun = { databaseId: number; headSha: string };

const DispatchRunSchema = z.object({
  databaseId: PositiveIdSchema,
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
});

function listDispatchRuns(branch: string): DispatchRun[] {
  const raw = gh([
    'run',
    'list',
    '--workflow',
    WORKFLOW_FILE,
    '--branch',
    branch,
    '--event',
    'workflow_dispatch',
    '--limit',
    '30',
    '--json',
    'databaseId,headSha',
  ]);
  return z.array(DispatchRunSchema).parse(JSON.parse(raw));
}

// `gh workflow run` reports no run id, and no listing exposes the dispatch
// inputs, so take the newest run on this commit that did not exist before
// the dispatch. `gh run list` returns newest first. Two hosts dispatching
// different platforms in the same poll window can still cross; that ends in
// the local build, which is the fallback anyway.
export function pickDispatchedRun(
  runs: DispatchRun[],
  before: ReadonlySet<number>,
  headSha: string
): number | undefined {
  return runs.find(run => !before.has(run.databaseId) && run.headSha === headSha)?.databaseId;
}

// Dispatch the workflow for the pushed branch and wait for it to finish.
// The ref fence runs first, so a moved or unverifiable ref stops here
// without any dispatch or new-run lookup.
function dispatchAndWatch(platform: 'ios' | 'android', ref: PushedRef): boolean {
  const startedAt = Date.now();
  if (!revalidatePushedRef(ref)) return false;
  const { branch, headSha: head } = ref;
  let before: Set<number>;
  try {
    before = new Set(listDispatchRuns(branch).map(run => run.databaseId));
  } catch (error) {
    log(`cannot list existing runs (${message(error)})`);
    return false;
  }
  try {
    gh(['workflow', 'run', WORKFLOW_FILE, '--ref', branch, '-f', `platform=${platform}`]);
  } catch (error) {
    // Typical cause: the workflow is not on the default branch yet —
    // workflow_dispatch only resolves workflows registered there.
    log(`workflow dispatch failed (${message(error)})`);
    return false;
  }
  log(`dispatched ${WORKFLOW_FILE} for ${platform} on ${branch}; waiting for the run`);
  let runId: number | undefined;
  for (let attempt = 0; attempt < 12 && runId === undefined; attempt++) {
    sleepSync(5000);
    try {
      runId = pickDispatchedRun(listDispatchRuns(branch), before, head);
    } catch {
      // Keep polling; the run can lag the dispatch.
    }
  }
  if (runId === undefined) {
    log('dispatched run never appeared');
    return false;
  }
  return watchRun(runId, startedAt);
}

// Wall clock spent waiting on CI. Waiting only pays while it stays under a
// local compile; log it so that stays measurable instead of assumed.
function waited(since: number): string {
  return `${((Date.now() - since) / 60000).toFixed(1)}m`;
}

function versionParts(version: unknown): number[] | undefined {
  if (typeof version !== 'string' || !/^\d+(\.\d+)*$/.test(version)) return undefined;
  return version.split('.').map(Number);
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// The artifact name keys on nativeHash alone, so the runner's Xcode can differ
// from the host's. A simulator app built against an SDK newer than the target
// simulator's runtime never launches; an equal or newer runtime runs it.
// Throwing here drops us onto the local build instead.
export function assertSimulatorRuntimeSupports(
  toolchain: unknown,
  simulatorRuntimeVersion: string
): void {
  const sdkVersion =
    typeof toolchain === 'object' && toolchain !== null && 'simulatorSdkVersion' in toolchain
      ? toolchain.simulatorSdkVersion
      : undefined;
  const sdk = versionParts(sdkVersion);
  const runtime = versionParts(simulatorRuntimeVersion);
  if (!sdk || !runtime || compareVersions(sdk, runtime) > 0) {
    throw new Error(
      `artifact simulator SDK ${String(sdkVersion)} cannot run on simulator runtime ${simulatorRuntimeVersion}`
    );
  }
}

// Unpack a remote iOS artifact's Kilo.app into the products directory the
// local build pipeline reads from. The artifact carries a tarball because
// upload-artifact's zip drops the executable bit.
export function fetchIosApp(args: {
  nativeHash: string;
  productsDir: string;
  simulatorRuntimeVersion: string;
}): boolean {
  return withArtifact('ios', args.nativeHash, unpacked => {
    const tarball = path.join(unpacked, `ios-${args.nativeHash}.tar.gz`);
    if (!fs.existsSync(tarball))
      throw new Error(`artifact is missing ios-${args.nativeHash}.tar.gz`);
    // Read the toolchain first, into scratch, so productsDir only ever
    // receives Kilo.app. An artifact built before toolchain.json existed
    // fails this extract, which is the same fall-back-to-local path.
    execFileSync('tar', ['-xzf', tarball, '-C', unpacked, 'toolchain.json'], { stdio: 'ignore' });
    assertSimulatorRuntimeSupports(
      JSON.parse(fs.readFileSync(path.join(unpacked, 'toolchain.json'), 'utf8')),
      args.simulatorRuntimeVersion
    );
    execFileSync('tar', ['-xzf', tarball, '-C', args.productsDir, 'Kilo.app'], { stdio: 'ignore' });
    if (!fs.existsSync(path.join(args.productsDir, 'Kilo.app'))) {
      throw new Error('artifact tarball did not contain Kilo.app');
    }
  });
}

// Copy a remote Android artifact's Kilo.apk into destDir and return its path.
export function fetchAndroidApk(args: { nativeHash: string; destDir: string }): string | undefined {
  const target = path.join(args.destDir, 'Kilo-remote.apk');
  const ok = withArtifact('android', args.nativeHash, unpacked => {
    const apk = path.join(unpacked, 'Kilo.apk');
    if (!fs.existsSync(apk)) throw new Error('artifact is missing Kilo.apk');
    fs.copyFileSync(apk, target);
  });
  return ok ? target : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleepSync(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}
