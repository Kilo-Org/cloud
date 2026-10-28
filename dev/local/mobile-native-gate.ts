import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { artifactName, findNativeArtifacts } from './mobile-remote-native';

export const NATIVE_WORKFLOW_PATH = '.github/workflows/mobile-native-build.yml';

type Platform = 'ios' | 'android';

const PLATFORMS: readonly Platform[] = ['ios', 'android'];

const PULL_REQUEST_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;

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

function lookupArtifact(repository: string, name: string): ArtifactLookup {
  const live = findNativeArtifacts(name, repository, process.env.GITHUB_SHA ?? '');
  const durable = live.find(
    artifact =>
      Date.parse(artifact.expires_at ?? '') - Date.parse(artifact.created_at ?? '') >
      PULL_REQUEST_ARTIFACT_RETENTION_MS
  );
  const found = durable ?? live[0];
  if (!found) return { state: 'missing' };
  return {
    state: durable ? 'durable' : 'short',
    artifact: { id: found.id, name: found.name },
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

// A lookup failure must not cost the build. The safe direction is "not
// published": the job builds, which is the duplicate this re-check exists to
// avoid, not a hash left without an artifact.
function lookupOrMissing(repository: string, name: string): ArtifactLookup {
  try {
    return lookupArtifact(repository, name);
  } catch (error) {
    process.stderr.write(
      `artifact ${name}: lookup failed (${error instanceof Error ? error.message : error}); ` +
        'treating it as unpublished\n'
    );
    return { state: 'missing' };
  }
}

// A heavy job re-checks its own artifact once its concurrency slot is free:
// the run that held the slot may have published it, and a second build of the
// same nativeHash is the waste this workflow exists to avoid. A pull_request
// run accepts the short-lived artifact it would publish itself; anything else
// must find the durable one.
function isPublished(name: string): boolean {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const found = lookupOrMissing(repository, name);
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
      const found = lookupOrMissing(repository, name);
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
