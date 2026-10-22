// Decide the `mobile-native-build` gate: which platforms to build, which to
// copy from a short-lived artifact, and the artifact-name prefix a
// pull_request run publishes under.
//
// A pull request that edits the workflow file itself is validating that edit,
// so its artifacts must stay out of the namespace hosts install from
// (dev/local/mobile-remote-native.ts, which looks up the plain
// mobile-native-<platform>-<nativeHash> name) and are keyed on the workflow
// file as well, so each revision of it builds once and a re-push skips.
// Every other pull_request run exists because a native input changed: it
// publishes the plain name a fleet host installs instead of compiling.
// A run that publishes a durable artifact (push, workflow_dispatch) skips only
// on a durable artifact, so the one-day pull_request artifact cannot leave
// main without the build it keeps for hosts. When that short-lived artifact is
// the only one, the run promotes it (copies it under the same name with the
// durable retention) instead of spending a runner on a second build.
//
// A finished artifact is the only thing the gate can see, and one native build
// takes longer than the gap between two pushes of the same native inputs, so
// the workflow also serializes the jobs of one nativeHash behind a job-level
// concurrency group and each heavy job re-checks its artifact (`--published`)
// before it builds.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { artifactName } from './mobile-remote-native';

export const NATIVE_WORKFLOW_PATH = '.github/workflows/mobile-native-build.yml';

type Platform = 'ios' | 'android';

const PLATFORMS: readonly Platform[] = ['ios', 'android'];

// The workflow gives a pull_request artifact one day and a push or
// workflow_dispatch artifact the durable 90 (retention-days in
// .github/workflows/mobile-native-build.yml). A pull_request run publishes the
// plain name for hosts to install, but a run that publishes a durable artifact
// must not let that one-day artifact satisfy its skip: once it expires main
// has no durable build for the nativeHash and every host falls back to
// compiling.
const PULL_REQUEST_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;

// Where the artifact lookup for one name stands.
// - `missing`: nothing live; the platform must be built.
// - `short`: a live artifact whose own lifetime is the pull_request one. A
//   pull_request run is done; a run that must publish a durable artifact
//   promotes this one instead of rebuilding.
// - `durable`: a long-lived artifact; every run is done.
export type ArtifactState = 'missing' | 'short' | 'durable';

export type ArtifactLookup = {
  state: ArtifactState;
  // Present unless the state is `missing`. The promote job copies this one.
  artifact?: { id: number; name: string };
};

export type PlatformPlan = {
  need: boolean;
  promote?: { id: number; name: string };
};

export type NativeBuildGate = {
  prefix: string;
  platforms: Record<Platform, PlatformPlan>;
};

// A pull request only gets the out-of-namespace prefix when it changes the
// workflow file; the prefix keys on the workflow revision so re-pushing the
// same edit skips and editing it builds once.
export function pullRequestArtifactPrefix(args: {
  prNumber: string;
  workflowHash: string;
  changedFiles: readonly string[];
}): string {
  if (!args.changedFiles.includes(NATIVE_WORKFLOW_PATH)) return '';
  return `pr${args.prNumber}-${args.workflowHash}-`;
}

export function decideNativeBuildGate(input: {
  eventName: string;
  platform: string;
  prNumber: string;
  workflowHash: string;
  changedFiles: readonly string[];
  iosHash: string;
  androidHash: string;
  lookup: (name: string) => ArtifactLookup;
}): NativeBuildGate {
  const prefix =
    input.eventName === 'pull_request'
      ? pullRequestArtifactPrefix({
          prNumber: input.prNumber,
          workflowHash: input.workflowHash,
          changedFiles: input.changedFiles,
        })
      : '';
  // Only a pull_request run publishes the short-lived artifact; a push or
  // dispatch run publishes the durable one, so it may only skip on a durable
  // artifact (a pull_request artifact expires in a day and would leave main
  // without a build).
  const requireDurable = input.eventName !== 'pull_request';
  const plan = (platform: Platform, hash: string): PlatformPlan => {
    if (input.platform !== 'all' && input.platform !== platform) return { need: false };
    // Same name a host looks up (dev/local/mobile-remote-native.ts), so a
    // published artifact is installable and an existing one is skipped.
    const found = input.lookup(`${prefix}${artifactName(platform, hash)}`);
    if (found.state === 'durable') return { need: false };
    if (found.state === 'short') {
      return requireDurable && found.artifact
        ? { need: false, promote: found.artifact }
        : { need: false };
    }
    return { need: true };
  };
  return {
    prefix,
    platforms: { ios: plan('ios', input.iosHash), android: plan('android', input.androidHash) },
  };
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

type ArtifactRecord = {
  id?: number;
  name?: string;
  created_at?: string;
  expires_at?: string;
  expired?: boolean;
};

// The API lists every artifact under a name, newest first, expired ones
// included. A durable artifact wins; otherwise the newest live one is what a
// promote copies. The page holds 100: one nativeHash was observed with 11
// uploads, and the durable one must not fall off the page behind them.
function lookupArtifact(repository: string, name: string): ArtifactLookup {
  const raw = gh(['api', `repos/${repository}/actions/artifacts?name=${name}&per_page=100`]);
  const parsed = JSON.parse(raw) as { artifacts?: ArtifactRecord[] };
  if (!Array.isArray(parsed.artifacts)) {
    throw new Error(`unexpected artifact listing for ${name}: ${raw.trim()}`);
  }
  const live = parsed.artifacts.filter(
    artifact => artifact.expired !== true && artifact.id !== undefined
  );
  const durable = live.find(
    artifact =>
      Date.parse(artifact.expires_at ?? '') - Date.parse(artifact.created_at ?? '') >
      PULL_REQUEST_ARTIFACT_RETENTION_MS
  );
  const found = durable ?? live[0];
  if (!found || found.id === undefined) return { state: 'missing' };
  return {
    state: durable ? 'durable' : 'short',
    artifact: { id: found.id, name: found.name ?? name },
  };
}

// The API lists the PR's changed files against its base; a workflow-file edit
// anywhere in the diff keeps the pull_request run out of the install
// namespace. Paginated so a large PR is not truncated at the first page.
function changedPullRequestFiles(repository: string, prNumber: string): string[] {
  const raw = gh([
    'api',
    `repos/${repository}/pulls/${prNumber}/files?per_page=100`,
    '--paginate',
    '--jq',
    '.[].filename',
  ]);
  return [
    ...new Set(
      raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    ),
  ];
}

function workflowFileHash(): string {
  const content = fs.readFileSync(NATIVE_WORKFLOW_PATH);
  return createHash('sha256').update(content).digest('hex').slice(0, 8);
}

function appendOutput(key: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    process.stdout.write(`${key}=${value}\n`);
    return;
  }
  fs.appendFileSync(outputPath, `${key}=${value}\n`);
}

// A heavy job re-checks its own artifact once its concurrency slot is free:
// the run that held the slot may have published it, and a second build of the
// same nativeHash is the waste this workflow exists to avoid. A pull_request
// run accepts the short-lived artifact it would publish itself; anything else
// must find the durable one.
function isPublished(name: string): boolean {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const found = lookupArtifact(repository, name);
  if (found.state === 'durable') return true;
  return found.state === 'short' && process.env.GITHUB_EVENT_NAME === 'pull_request';
}

function main(): void {
  const first = process.argv[2] ?? '';
  if (first === '--published') {
    const name = process.argv[3] ?? '';
    if (!name || process.argv.length !== 4) {
      throw new Error('Usage: tsx dev/local/mobile-native-gate.ts --published <artifactName>');
    }
    const published = isPublished(name);
    process.stderr.write(`artifact ${name}: ${published ? 'published' : 'missing'}\n`);
    appendOutput('published', String(published));
    return;
  }
  const iosHash = first;
  const androidHash = process.argv[3] ?? '';
  if (!iosHash || !androidHash) {
    throw new Error('Usage: tsx dev/local/mobile-native-gate.ts <iosHash> <androidHash>');
  }
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const prNumber = process.env.PR_NUMBER ?? '';
  const gate = decideNativeBuildGate({
    eventName,
    platform: process.env.PLATFORM ?? 'all',
    prNumber,
    workflowHash: eventName === 'pull_request' ? workflowFileHash() : '',
    changedFiles: eventName === 'pull_request' ? changedPullRequestFiles(repository, prNumber) : [],
    iosHash,
    androidHash,
    lookup: name => {
      const found = lookupArtifact(repository, name);
      process.stderr.write(`artifact ${name}: ${found.state}\n`);
      return found;
    },
  });
  appendOutput('prefix', gate.prefix);
  for (const platform of PLATFORMS) {
    const plan = gate.platforms[platform];
    appendOutput(`need_${platform}`, String(plan.need));
    appendOutput(`promote_${platform}`, String(plan.promote !== undefined));
    appendOutput(`promote_${platform}_artifact_id`, plan.promote ? String(plan.promote.id) : '');
    appendOutput(`promote_${platform}_name`, plan.promote?.name ?? '');
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
