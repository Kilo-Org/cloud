import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { artifactName, findNativeArtifacts } from './mobile-remote-native';

export const NATIVE_WORKFLOW_PATH = '.github/workflows/mobile-native-build.yml';

type Platform = 'ios' | 'android';

const PLATFORMS: readonly Platform[] = ['ios', 'android'];

export type PlatformPlan = {
  need: boolean;
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
  lookup: (name: string) => boolean;
}): NativeBuildGate {
  const prefix =
    input.eventName === 'pull_request'
      ? pullRequestArtifactPrefix({
          prNumber: input.prNumber,
          workflowHash: input.workflowHash,
          changedFiles: input.changedFiles,
        })
      : '';
  const plan = (platform: Platform, hash: string): PlatformPlan => {
    if (input.platform !== 'all' && input.platform !== platform) return { need: false };
    return { need: !input.lookup(`${prefix}${artifactName(platform, hash)}`) };
  };
  return {
    prefix,
    platforms: { ios: plan('ios', input.iosHash), android: plan('android', input.androidHash) },
  };
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function pullRequestValidationScope():
  | { pullRequestNumber: number; headRepositoryId: number }
  | undefined {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return undefined;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('Missing GITHUB_EVENT_PATH for pull_request');
  const event: unknown = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  if (
    typeof event !== 'object' ||
    event === null ||
    !('number' in event) ||
    typeof event.number !== 'number' ||
    !Number.isSafeInteger(event.number) ||
    event.number <= 0 ||
    !('pull_request' in event) ||
    typeof event.pull_request !== 'object' ||
    event.pull_request === null ||
    !('head' in event.pull_request) ||
    typeof event.pull_request.head !== 'object' ||
    event.pull_request.head === null ||
    !('repo' in event.pull_request.head) ||
    typeof event.pull_request.head.repo !== 'object' ||
    event.pull_request.head.repo === null ||
    !('id' in event.pull_request.head.repo) ||
    typeof event.pull_request.head.repo.id !== 'number' ||
    !Number.isSafeInteger(event.pull_request.head.repo.id) ||
    event.pull_request.head.repo.id <= 0
  ) {
    throw new Error('Invalid pull_request number or head repository ID');
  }
  return {
    pullRequestNumber: event.number,
    headRepositoryId: event.pull_request.head.repo.id,
  };
}

function lookupArtifact(repository: string, name: string): boolean {
  return (
    findNativeArtifacts(
      name,
      repository,
      process.env.GITHUB_SHA ?? '',
      pullRequestValidationScope()
    ).length > 0
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

// A lookup failure must not cost the build. The safe direction is "not
// published": the job builds, which is the duplicate this re-check exists to
// avoid, not a hash left without an artifact.
function lookupOrMissing(repository: string, name: string): boolean {
  try {
    return lookupArtifact(repository, name);
  } catch (error) {
    process.stderr.write(
      `artifact ${name}: lookup failed (${error instanceof Error ? error.message : error}); ` +
        'treating it as unpublished\n'
    );
    return false;
  }
}

function isPublished(name: string): boolean {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  return lookupOrMissing(repository, name);
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
      const found = lookupOrMissing(repository, name);
      process.stderr.write(`artifact ${name}: ${found ? 'published' : 'missing'}\n`);
      return found;
    },
  });
  appendOutput('prefix', gate.prefix);
  for (const platform of PLATFORMS) {
    const plan = gate.platforms[platform];
    appendOutput(`need_${platform}`, String(plan.need));
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
