// Decide the `mobile-native-build` gate: which platforms to build, and the
// artifact-name prefix a pull_request run publishes under.
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
// main without the build it keeps for hosts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { artifactName } from './mobile-remote-native';

export const NATIVE_WORKFLOW_PATH = '.github/workflows/mobile-native-build.yml';

type Platform = 'ios' | 'android';

// The workflow gives a pull_request artifact one day and a push or
// workflow_dispatch artifact the durable 90 (retention-days in
// .github/workflows/mobile-native-build.yml). A pull_request run publishes the
// plain name for hosts to install, but a run that publishes a durable artifact
// must not let that one-day artifact satisfy its skip: once it expires main
// has no durable build for the nativeHash and every host falls back to
// compiling.
const PULL_REQUEST_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;

export type ArtifactLookupOptions = { requireDurable: boolean };

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
  artifactExists: (artifactName: string, options: ArtifactLookupOptions) => boolean;
}): { prefix: string; needIos: boolean; needAndroid: boolean } {
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
  const need = (platform: Platform, hash: string): boolean => {
    if (input.platform !== 'all' && input.platform !== platform) return false;
    // Same name a host looks up (dev/local/mobile-remote-native.ts), so a
    // published artifact is installable and an existing one is skipped.
    return !input.artifactExists(`${prefix}${artifactName(platform, hash)}`, { requireDurable });
  };
  return {
    prefix,
    needIos: need('ios', input.iosHash),
    needAndroid: need('android', input.androidHash),
  };
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

type ArtifactRecord = { created_at?: string; expires_at?: string; expired?: boolean };

// An artifact exists when the API lists a non-expired one under the name. A
// run that publishes a durable artifact needs one whose own lifetime is the
// durable one: the pull_request run's one-day artifact (retention-days: 1)
// must not make a push skip the build main keeps for 90 days.
function artifactExists(repository: string, name: string, options: ArtifactLookupOptions): boolean {
  const raw = gh(['api', `repos/${repository}/actions/artifacts?name=${name}&per_page=10`]);
  const parsed = JSON.parse(raw) as { artifacts?: ArtifactRecord[] };
  if (!Array.isArray(parsed.artifacts)) {
    throw new Error(`unexpected artifact listing for ${name}: ${raw.trim()}`);
  }
  const live = parsed.artifacts.filter(artifact => artifact.expired !== true);
  if (!options.requireDurable) return live.length > 0;
  return live.some(
    artifact =>
      Date.parse(artifact.expires_at ?? '') - Date.parse(artifact.created_at ?? '') >
      PULL_REQUEST_ARTIFACT_RETENTION_MS
  );
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

function main(): void {
  const iosHash = process.argv[2] ?? '';
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
    artifactExists: (name, options) => {
      const exists = artifactExists(repository, name, options);
      if (exists) process.stderr.write(`artifact ${name} already exists\n`);
      return exists;
    },
  });
  appendOutput('prefix', gate.prefix);
  appendOutput('need_ios', String(gate.needIos));
  appendOutput('need_android', String(gate.needAndroid));
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
