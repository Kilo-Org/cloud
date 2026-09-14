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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { artifactName } from './mobile-remote-native';

export const NATIVE_WORKFLOW_PATH = '.github/workflows/mobile-native-build.yml';

type Platform = 'ios' | 'android';

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
  artifactExists: (artifactName: string) => boolean;
}): { prefix: string; needIos: boolean; needAndroid: boolean } {
  const prefix =
    input.eventName === 'pull_request'
      ? pullRequestArtifactPrefix({
          prNumber: input.prNumber,
          workflowHash: input.workflowHash,
          changedFiles: input.changedFiles,
        })
      : '';
  const need = (platform: Platform, hash: string): boolean => {
    if (input.platform !== 'all' && input.platform !== platform) return false;
    // Same name a host looks up (dev/local/mobile-remote-native.ts), so a
    // published artifact is installable and an existing one is skipped.
    return !input.artifactExists(`${prefix}${artifactName(platform, hash)}`);
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

function artifactExists(repository: string, name: string): boolean {
  const raw = gh([
    'api',
    `repos/${repository}/actions/artifacts?name=${name}&per_page=10`,
    '--jq',
    '[.artifacts[] | select(.expired | not)] | length',
  ]);
  const count = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(count)) {
    throw new Error(`unexpected artifact count for ${name}: ${raw.trim()}`);
  }
  return count > 0;
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
    artifactExists: name => {
      const exists = artifactExists(repository, name);
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
