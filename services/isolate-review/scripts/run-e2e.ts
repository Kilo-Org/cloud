import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { startFixture } from './e2e-fixture-server.ts';
import {
  createPrivateArtifacts,
  fixturePrompt,
  hashText,
  jsonRequest,
  readPrivateJson,
  readPrivateText,
} from './review-evidence.ts';

const FIXTURE_PORT = 8877;
const EXPECTED_FIXTURE_GITHUB_API_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const EXPECTED_FIXTURE_CLONE_URL_TEMPLATE = `${EXPECTED_FIXTURE_GITHUB_API_URL}/{owner}/{repo}.git`;
const POLL_MS = 5_000;
const TIMEOUT_MS = 10 * 60_000;
const E2E_MODEL = 'kilo-auto/efficient';
const E2E_GIT_TOKEN = 'e2e-not-a-github-token';
const REQUIRE_TASK_CALL = process.env.ISOLATE_E2E_REQUIRE_TASK === '1';
const TASK_CALL_E2E_INSTRUCTION = `# TASK-CALL E2E OVERRIDE
This opt-in run exercises the normal Small-review delegation path. After a
successful pr_diff call and before reading the delegated source files, you
MUST call task exactly once with:

- description: "Review variadic value collection changes"
- prompt: "Inspect only lib/argument.js and lib/option.js for changed-line issues in the variadic value collection changes. Use pr_diff and read the relevant source. Return a non-empty code-review verdict: for every finding include path, line, severity, and evidence-based rationale; if there is no high-confidence issue, explicitly state that no actionable changed-line issue was found in the assigned area. Do not publish comments."
- subagent_type: "general"
- task_id: "e2e-task-call"

Wait for the non-empty completed task result, verify it against the diff, and
use it while completing the parent review. This instruction exists only for
the opt-in task-call E2E mode.`;
const SUCCESS_TOOL_STATE = 'output-available';
const FORBIDDEN_TOOLS = new Set(['write', 'edit', 'delete', 'bash']);
const GITHUB_TOOLS = new Set(['pr_view', 'pr_diff', 'pr_comments']);
const WORKSPACE_TOOLS = new Set(['read', 'grep', 'list', 'find']);
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '../../..');
const artifactsRoot = join(scriptsDir, 'last-e2e');
let artifactWriter: ReturnType<typeof createPrivateArtifacts> | undefined;
const fixturesDir = join(scriptsDir, 'fixtures');
const unpackedGitDir = join(fixturesDir, '.work/kilo-e2e/review-fixture.git');
const treeFilesPath = join(fixturesDir, 'tree-files.json');
const pullDiffPath = join(fixturesDir, 'github/pull.diff');

type DevService = {
  name: string;
  port: number;
  status: string;
};

type DevStatus = {
  services?: DevService[];
};

function readWorkerDevVar(name: string): string | undefined {
  try {
    const contents = readFileSync(join(repoRoot, 'services/isolate-review/.dev.vars'), 'utf8');
    const line = contents.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
    return line?.replace(/^['"]|['"]$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

function hasFixtureRouting(): boolean {
  if (
    readWorkerDevVar('GITHUB_API_URL') === EXPECTED_FIXTURE_GITHUB_API_URL &&
    readWorkerDevVar('GIT_CLONE_URL_TEMPLATE') === EXPECTED_FIXTURE_CLONE_URL_TEMPLATE
  ) {
    return true;
  }

  console.error(`GITHUB_API_URL=${EXPECTED_FIXTURE_GITHUB_API_URL}`);
  console.error(`GIT_CLONE_URL_TEMPLATE=${EXPECTED_FIXTURE_CLONE_URL_TEMPLATE}`);
  console.error('services/isolate-review/.dev.vars');
  console.error('pnpm dev:restart cloudflare-isolate-review');
  return false;
}

type FixtureMeta = {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
};

type FixtureHandle = {
  origin: string;
  stop: () => Promise<void> | void;
  getWrites?: () => unknown;
  writes?: unknown;
};

type ReviewStatus = {
  runId?: string;
  status?: string;
  error?: unknown;
  published?: unknown;
  publishedAt?: unknown;
  finalText?: unknown;
};

type TranscriptMessage = {
  id?: unknown;
  role?: unknown;
  text?: unknown;
};

type TranscriptToolCall = {
  toolName?: unknown;
  state?: unknown;
  input?: unknown;
  output?: unknown;
  errorText?: unknown;
};

type Transcript = {
  runId?: unknown;
  messages?: TranscriptMessage[];
  toolCalls?: TranscriptToolCall[];
};

type HardCheck = {
  name: string;
  pass: boolean;
  detail?: string;
};

type SoftNotes = {
  flaggedChangedLine: boolean | null;
  commentsOnDiffLines: boolean | null;
  elapsedMs: number;
  toolCallCount: number;
  messageCount: number;
  recoveredToolErrors: string[];
  noIssuesFound: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function spawnJson(command: string, args: string[], cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(
          new Error(`${command} ${args.join(' ')} exited ${code}${stderr ? `\n${stderr}` : ''}`)
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Failed to parse JSON from ${command}: ${String(error)}\n${stdout}`));
      }
    });
  });
}

function requireService(status: DevStatus, name: string): DevService {
  const service = status.services?.find(entry => entry.name === name);
  if (!service || service.status !== 'up' || !Number.isInteger(service.port) || service.port < 1) {
    fail(
      `${name} is not up. Start the local stack first (do not start it from this harness):\n` +
        `  KILO_PORT_OFFSET=auto pnpm dev:start isolate-review auto-routing`
    );
  }
  return service;
}

function isFixtureMeta(value: unknown): value is FixtureMeta {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.owner === 'string' &&
    record.owner.length > 0 &&
    typeof record.repo === 'string' &&
    record.repo.length > 0 &&
    typeof record.pullNumber === 'number' &&
    Number.isSafeInteger(record.pullNumber) &&
    record.pullNumber >= 1 &&
    typeof record.headSha === 'string' &&
    /^[0-9a-f]{40}$/i.test(record.headSha)
  );
}

function readMeta(): FixtureMeta {
  const path = join(fixturesDir, 'meta.json');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isFixtureMeta(parsed)) {
    fail(`Invalid fixture meta at ${path} (need owner, repo, pullNumber, 40-hex headSha)`);
  }
  return parsed;
}

function isFixtureHandle(value: unknown): value is FixtureHandle {
  const record = asRecord(value);
  return (
    !!record &&
    typeof record.origin === 'string' &&
    record.origin.length > 0 &&
    typeof record.stop === 'function'
  );
}

function collectWrites(fixture: FixtureHandle): unknown[] {
  if (typeof fixture.getWrites === 'function') {
    const writes = fixture.getWrites();
    if (!Array.isArray(writes)) fail('startFixture().getWrites() must return an array');
    return writes;
  }
  if (Array.isArray(fixture.writes)) return fixture.writes;
  fail('startFixture() must expose getWrites() or writes[]');
}

function listTreeFiles(): Set<string> {
  try {
    const output = execFileSync(
      'git',
      ['--git-dir', unpackedGitDir, 'ls-tree', '-r', '--name-only', 'HEAD'],
      {
        encoding: 'utf8',
      }
    );
    const files = output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (files.length === 0) throw new Error('empty git ls-tree');
    return new Set(files);
  } catch {
    const parsed: unknown = JSON.parse(readFileSync(treeFilesPath, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(entry => typeof entry === 'string')) {
      fail(`Could not list fixture tree via git ls-tree or ${treeFilesPath}`);
    }
    return new Set(parsed);
  }
}

function normalizeRepoPath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  const withoutWorkspace = trimmed.replace(/^\/workspace\/?/, '');
  const relative = withoutWorkspace.replace(/^\/+/, '');
  if (!relative || relative === '.') return undefined;
  const parts = relative.split('/').filter(part => part && part !== '.');
  if (parts.length === 0 || parts.some(part => part === '..')) return undefined;
  return parts.join('/');
}

function toolInputPaths(input: unknown): string[] {
  const record = asRecord(input);
  if (!record) return [];
  const paths: string[] = [];
  for (const key of ['path', 'file', 'target'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) paths.push(value);
  }
  return paths;
}

function pathExistsInTree(path: string, tree: Set<string>): boolean {
  const normalized = normalizeRepoPath(path);
  if (!normalized) return false;
  if (tree.has(normalized)) return true;
  const prefix = `${normalized}/`;
  for (const file of tree) {
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

function isSuccessfulTool(call: TranscriptToolCall, name: string): boolean {
  return call.toolName === name && call.state === SUCCESS_TOOL_STATE;
}

function wouldSendBody(output: unknown): string | undefined {
  const record = asRecord(output);
  const wouldSend = asRecord(record?.wouldSend);
  if (!wouldSend) return undefined;
  if (typeof wouldSend.body === 'string') return wouldSend.body;
  const payload = asRecord(wouldSend.payload);
  return typeof payload?.body === 'string' ? payload.body : undefined;
}

function taskResultEnvelope(output: unknown):
  | {
      text: string;
      metadata?: Record<string, unknown>;
      structured: boolean;
    }
  | undefined {
  if (typeof output === 'string') {
    return { text: output, structured: false };
  }
  const record = asRecord(output);
  if (!record || typeof record.output !== 'string') return undefined;
  return {
    text: record.output,
    metadata: asRecord(record.metadata),
    structured: true,
  };
}

function taskResultText(output: unknown): string | undefined {
  const envelope = taskResultEnvelope(output);
  const match = envelope && /<task_result>\s*([\s\S]*?)\s*<\/task_result>/.exec(envelope.text);
  const result = match?.[1]?.trim();
  return result || undefined;
}

function reviewComments(output: unknown): Array<{ path: string; line?: number; side?: string }> {
  const record = asRecord(output);
  const wouldSend = asRecord(record?.wouldSend);
  const comments = wouldSend?.comments;
  if (!Array.isArray(comments)) return [];
  const result: Array<{ path: string; line?: number; side?: string }> = [];
  for (const comment of comments) {
    const entry = asRecord(comment);
    if (!entry || typeof entry.path !== 'string') continue;
    result.push({
      path: entry.path,
      line: typeof entry.line === 'number' ? entry.line : undefined,
      side: typeof entry.side === 'string' ? entry.side : undefined,
    });
  }
  return result;
}

function parseRightSideLines(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let currentPath: string | undefined;
  let rightLine = 0;
  for (const line of diff.split('\n')) {
    const gitHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (gitHeader) {
      currentPath = gitHeader[2];
      continue;
    }
    const plusPath = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (plusPath) {
      currentPath = plusPath[1] === '/dev/null' ? undefined : plusPath[1];
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      rightLine = Number(hunk[1]);
      continue;
    }
    if (
      !currentPath ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ')
    ) {
      continue;
    }
    if (line.startsWith('-')) continue;
    if (line.startsWith('+') || line.startsWith(' ') || line === '') {
      if (!lines.has(currentPath)) lines.set(currentPath, new Set());
      lines.get(currentPath)?.add(rightLine);
      rightLine += 1;
    }
  }
  return lines;
}

async function readDevStatus(): Promise<DevStatus> {
  const parsed = await spawnJson('pnpm', ['dev:status', '--json'], repoRoot);
  const record = asRecord(parsed);
  const services = record?.services;
  if (!Array.isArray(services)) return { services: [] };
  const entries: DevService[] = [];
  for (const service of services) {
    const entry = asRecord(service);
    if (!entry || typeof entry.name !== 'string') continue;
    entries.push({
      name: entry.name,
      port: typeof entry.port === 'number' ? entry.port : 0,
      status: typeof entry.status === 'string' ? entry.status : 'down',
    });
  }
  return { services: entries };
}

function firstUserText(transcript: Transcript): string {
  const message = transcript.messages?.find(entry => entry.role === 'user');
  return typeof message?.text === 'string' ? message.text : '';
}

function evaluateHardChecks(options: {
  accepted: boolean;
  status: ReviewStatus | undefined;
  transcript: Transcript | undefined;
  writes: unknown[];
  tree: Set<string>;
  requireTaskCall: boolean;
  expectedUserPrompt: string;
}): HardCheck[] {
  const { accepted, status, transcript, writes, tree, requireTaskCall, expectedUserPrompt } =
    options;
  const toolCalls = transcript?.toolCalls ?? [];
  const userText = transcript ? firstUserText(transcript) : '';
  const upsert = toolCalls.find(call => call.toolName === 'upsert_summary');
  const submit = toolCalls.find(call => call.toolName === 'submit_review');
  const taskCalls = toolCalls.filter(call => call.toolName === 'task');
  const githubOk = toolCalls.some(
    call =>
      typeof call.toolName === 'string' &&
      GITHUB_TOOLS.has(call.toolName) &&
      call.state === SUCCESS_TOOL_STATE
  );
  const workspaceOk = toolCalls.some(
    call =>
      typeof call.toolName === 'string' &&
      WORKSPACE_TOOLS.has(call.toolName) &&
      call.state === SUCCESS_TOOL_STATE
  );
  const realTreeHit = toolCalls.some(call => {
    if (
      (call.toolName !== 'read' && call.toolName !== 'grep') ||
      call.state !== SUCCESS_TOOL_STATE
    ) {
      return false;
    }
    return toolInputPaths(call.input).some(path => pathExistsInTree(path, tree));
  });
  const forbidden = toolCalls.filter(
    call => typeof call.toolName === 'string' && FORBIDDEN_TOOLS.has(call.toolName)
  );
  const submitComments = submit ? reviewComments(submit.output) : [];
  const workspacePrefixed = submitComments.filter(comment => comment.path.includes('/workspace/'));

  const hardChecks: HardCheck[] = [
    {
      name: 'HTTP 202 then status === completed',
      pass: accepted && status?.status === 'completed',
      detail: `accepted=${accepted} status=${String(status?.status ?? 'missing')}`,
    },
    {
      name: 'error absent',
      pass: status?.error === undefined || status.error === null || status.error === '',
      detail:
        status?.error === undefined || status.error === null || status.error === ''
          ? undefined
          : typeof status.error === 'string'
            ? status.error
            : JSON.stringify(status.error),
    },
    {
      name: 'published is not true; publishedAt absent',
      pass: status?.published !== true && status?.publishedAt === undefined,
      detail: `published=${String(status?.published)} publishedAt=${String(status?.publishedAt)}`,
    },
    {
      name: 'fixture POST/PATCH log empty',
      pass: writes.length === 0,
      detail: writes.length === 0 ? undefined : `${writes.length} write(s)`,
    },
    {
      name: 'successful pr_view / pr_diff / pr_comments',
      pass: githubOk,
    },
    {
      name: 'successful read / grep / list / find',
      pass: workspaceOk,
    },
    {
      name: 'read or grep path exists in fixture tree',
      pass: realTreeHit,
    },
    {
      name: 'upsert_summary dryRun with <!-- kilo-review --> body',
      pass:
        !!upsert &&
        asRecord(upsert.output)?.dryRun === true &&
        (wouldSendBody(upsert.output)?.startsWith('<!-- kilo-review -->') ?? false),
      detail: upsert
        ? `dryRun=${String(asRecord(upsert.output)?.dryRun)} bodyStarts=${String(
            wouldSendBody(upsert.output)?.startsWith('<!-- kilo-review -->')
          )}`
        : 'missing',
    },
    {
      name: 'submit_review dryRun with an empty review body and repo-relative paths',
      pass:
        !submit ||
        (asRecord(submit.output)?.dryRun === true &&
          wouldSendBody(submit.output) === '' &&
          workspacePrefixed.length === 0 &&
          submitComments.every(comment => Boolean(normalizeRepoPath(comment.path)))),
      detail: submit
        ? `dryRun=${String(asRecord(submit.output)?.dryRun)} emptyBody=${wouldSendBody(submit.output) === ''} comments=${submitComments.length} workspacePrefixed=${workspacePrefixed.length}`
        : 'absent',
    },
    {
      name: 'no write / edit / delete / bash tools',
      pass: forbidden.length === 0,
      detail: forbidden.map(call => String(call.toolName)).join(', ') || undefined,
    },
    {
      name: 'first user message matches the selected fixture prompt',
      pass: userText === expectedUserPrompt,
      detail: userText ? `promptHash=${hashText(userText)}` : 'missing user message',
    },
  ];

  if (requireTaskCall) {
    const task = taskCalls[0];
    const taskInput = asRecord(task?.input);
    const taskEnvelope = taskResultEnvelope(task?.output);
    const taskOutput = taskResultText(task?.output);
    const completed =
      taskCalls.length === 1 &&
      task?.state === SUCCESS_TOOL_STATE &&
      taskEnvelope?.structured === true &&
      taskEnvelope.text.includes('state="completed"') &&
      taskEnvelope.metadata?.taskId === 'e2e-task-call' &&
      taskEnvelope.metadata.state === 'completed';
    hardChecks.push({
      name: 'exactly one completed task delegation',
      pass: completed,
      detail: `calls=${taskCalls.length} state=${typeof task?.state === 'string' ? task.state : 'missing'} structured=${String(taskEnvelope?.structured ?? false)}`,
    });
    const codeReviewTask =
      taskInput?.description === 'Review variadic value collection changes' &&
      typeof taskInput.prompt === 'string' &&
      taskInput.prompt.includes('lib/argument.js') &&
      taskInput.prompt.includes('lib/option.js') &&
      taskInput.subagent_type === 'general' &&
      taskInput.task_id === 'e2e-task-call';
    hardChecks.push({
      name: 'task delegation targets a concrete review area',
      pass: codeReviewTask,
      detail: `description=${typeof taskInput?.description === 'string' ? taskInput.description : 'missing'}`,
    });
    const nonEmptyResult =
      typeof taskOutput === 'string' &&
      /lib\/(?:argument|option)\.js|no actionable changed-line issue|severity|finding/i.test(
        taskOutput
      );
    hardChecks.push({
      name: 'child returns a non-empty code-review verdict',
      pass: completed && nonEmptyResult,
      detail: `nonEmpty=${String(Boolean(taskOutput))} concrete=${String(nonEmptyResult)}`,
    });
    const taskIndex = toolCalls.indexOf(task);
    const parentContinued =
      taskIndex >= 0 &&
      toolCalls
        .slice(taskIndex + 1)
        .some(
          call =>
            (WORKSPACE_TOOLS.has(String(call.toolName)) ||
              call.toolName === 'submit_review' ||
              call.toolName === 'upsert_summary') &&
            call.state === SUCCESS_TOOL_STATE
        );
    hardChecks.push({
      name: 'parent continues review after receiving child verdict',
      pass: parentContinued,
      detail: `continued=${String(parentContinued)}`,
    });
    const parentSummary = upsert ? wouldSendBody(upsert.output) : undefined;
    const childNoFinding = /no actionable changed-line issue/i.test(taskOutput ?? '');
    const summaryAgreesWithChild =
      typeof parentSummary === 'string' &&
      parentSummary.includes('lib/argument.js') &&
      parentSummary.includes('lib/option.js') &&
      (childNoFinding
        ? /No Issues Found/i.test(parentSummary)
        : !/No Issues Found/i.test(parentSummary));
    hardChecks.push({
      name: 'parent summary reflects the child verdict and assigned files',
      pass: summaryAgreesWithChild,
      detail: `childNoFinding=${String(childNoFinding)} summaryPresent=${String(Boolean(parentSummary))}`,
    });
  }

  return hardChecks;
}

function evaluateSoftNotes(options: {
  status: ReviewStatus | undefined;
  transcript: Transcript | undefined;
  elapsedMs: number;
}): SoftNotes {
  const toolCalls = options.transcript?.toolCalls ?? [];
  const submit = toolCalls.find(call => call.toolName === 'submit_review');
  const comments = submit ? reviewComments(submit.output) : [];
  let commentsOnDiffLines: boolean | null = null;
  let flaggedChangedLine: boolean | null = null;
  try {
    const diff = readFileSync(pullDiffPath, 'utf8');
    const rightLines = parseRightSideLines(diff);
    if (comments.length === 0) {
      commentsOnDiffLines = null;
      flaggedChangedLine = false;
    } else {
      commentsOnDiffLines = comments.every(comment => {
        const path = normalizeRepoPath(comment.path);
        if (!path || comment.line === undefined) return false;
        return rightLines.get(path)?.has(comment.line) === true;
      });
      flaggedChangedLine = comments.some(comment => {
        const path = normalizeRepoPath(comment.path);
        if (!path || comment.line === undefined) return false;
        return rightLines.get(path)?.has(comment.line) === true;
      });
    }
  } catch {
    commentsOnDiffLines = null;
    flaggedChangedLine = comments.length > 0 ? null : false;
  }

  const recoveredToolErrors: string[] = [];
  for (const [index, call] of toolCalls.entries()) {
    const failed =
      call.state !== SUCCESS_TOOL_STATE ||
      (typeof call.errorText === 'string' && call.errorText.length > 0);
    if (!failed || typeof call.toolName !== 'string') continue;
    const recovered = toolCalls
      .slice(index + 1)
      .some(later => isSuccessfulTool(later, call.toolName as string));
    if (recovered) {
      recoveredToolErrors.push(
        `${call.toolName}: ${typeof call.errorText === 'string' && call.errorText ? call.errorText : String(call.state)}`
      );
    }
  }

  const summaryText = [
    typeof options.status?.finalText === 'string' ? options.status.finalText : '',
    wouldSendBody(toolCalls.find(call => call.toolName === 'upsert_summary')?.output) ?? '',
  ].join('\n');

  return {
    flaggedChangedLine,
    commentsOnDiffLines,
    elapsedMs: options.elapsedMs,
    toolCallCount: toolCalls.length,
    messageCount: options.transcript?.messages?.length ?? 0,
    recoveredToolErrors,
    noIssuesFound: /No Issues Found/i.test(summaryText),
  };
}

function writeArtifacts(files: Record<string, unknown>): void {
  if (!artifactWriter) fail('Artifact directory is not initialized');
  for (const [name, contents] of Object.entries(files)) artifactWriter(name, contents);
}

function printSummary(hard: HardCheck[], soft: SoftNotes, passed: boolean): void {
  console.log(`isolate-review e2e: ${passed ? 'PASS' : 'FAIL'}`);
  console.log('hard:');
  for (const check of hard) {
    console.log(`  [${check.pass ? 'ok' : 'FAIL'}] ${check.name}`);
  }
  console.log('soft:');
  console.log(
    `  flagged changed-line comment: ${soft.flaggedChangedLine === null ? 'unknown' : String(soft.flaggedChangedLine)}`
  );
  console.log(
    `  submit_review lines on pull.diff RIGHT side: ${
      soft.commentsOnDiffLines === null ? 'n/a' : String(soft.commentsOnDiffLines)
    }`
  );
  console.log(`  elapsedMs: ${soft.elapsedMs}`);
  console.log(`  toolCalls: ${soft.toolCallCount} messages: ${soft.messageCount}`);
  console.log(`  No Issues Found: ${String(soft.noIssuesFound)}`);
  console.log(
    `  recovered tool errors: ${soft.recoveredToolErrors.length} (details in private verdict)`
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      run: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      'prompt-file': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: pnpm exec tsx services/isolate-review/scripts/run-e2e.ts [--run] [--prompt-file PRIVATE_FILE]'
    );
    console.log(
      'Default: offline fixture preflight. --run starts the fixture server and billable dry-run inference, never real GitHub writes.'
    );
    console.log(
      'Prompt file: plain text or canonical prepared-request JSON, bound to fixture identity and prompt hash; no web imports.'
    );
    return;
  }
  const meta = readMeta();
  const promptFile = values['prompt-file'];
  const selectedPrompt = fixturePrompt(
    promptFile
      ? promptFile.endsWith('.json')
        ? readPrivateJson(promptFile)
        : readPrivateText(promptFile)
      : `Review ${meta.owner}/${meta.repo} PR #${meta.pullNumber} at ${meta.headSha}. The repository is checked out at /workspace. Activate github-cloud-review, inspect pr_view, pr_diff and pr_comments, then review with read-only workspace tools. Submit actionable inline findings together using submit_review and finish with upsert_summary beginning <!-- kilo-review -->. Do not execute code, edit files or invent a Cloud review ID.`,
    meta
  );
  const model = selectedPrompt.model ?? E2E_MODEL;
  const userPrompt = REQUIRE_TASK_CALL
    ? `${selectedPrompt.userPrompt}\n\n${TASK_CALL_E2E_INSTRUCTION}`
    : selectedPrompt.userPrompt;
  fixturePrompt(userPrompt);
  if (!values.run) {
    console.log(
      `Fixture preflight passed (${selectedPrompt.source}); no services or inference started. Add --run to execute.`
    );
    return;
  }
  if (!hasFixtureRouting()) {
    process.exitCode = 1;
    return;
  }

  const devStatus = await readDevStatus();
  const isolate = requireService(devStatus, 'cloudflare-isolate-review');
  requireService(devStatus, 'nextjs');
  const autoRouting = devStatus.services?.find(entry => entry.name === 'auto-routing');
  if (model.startsWith('kilo-auto/') && (!autoRouting || autoRouting.status !== 'up')) {
    console.log('warning: auto-routing is not up; kilo-auto/efficient may fall back to balanced');
  }

  const isolateOrigin = `http://127.0.0.1:${isolate.port}`;
  console.log(`isolate-review: ${isolateOrigin}`);

  const started = await startFixture({ port: FIXTURE_PORT });
  let exitCode = 1;
  try {
    if (!isFixtureHandle(started)) {
      fail('startFixture() must return { origin, stop }');
    }
    const fixture = started;
    console.log(`fixture origin: ${fixture.origin}`);
    const kiloToken = process.env.KILO_TOKEN?.trim();
    if (!kiloToken) {
      fail(
        'KILO_TOKEN is missing. Mint one with:\n' +
          '  pnpm -s dev:seed app:api-token <email> --expires-days=1 --json'
      );
    }
    const internalApiSecret =
      process.env.INTERNAL_API_SECRET?.trim() || readWorkerDevVar('INTERNAL_API_SECRET');
    if (!internalApiSecret) {
      fail(
        'INTERNAL_API_SECRET is missing. Run `pnpm dev:env` or export the same secret used by isolate-review.'
      );
    }
    mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
    const artifactsDir = join(artifactsRoot, randomUUID());
    artifactWriter = createPrivateArtifacts(artifactsDir, [kiloToken, internalApiSecret]);
    writeArtifacts({
      'prompt.json': {
        userPrompt,
        source: selectedPrompt.source,
        model,
        thinkingEffort: selectedPrompt.thinkingEffort ?? null,
        taskOverride: REQUIRE_TASK_CALL,
        hash: hashText(userPrompt),
      },
    });
    console.log(`Private artifacts: ${artifactsDir}`);
    const authHeaders = {
      Authorization: `Bearer ${kiloToken}`,
      'x-internal-api-key': internalApiSecret,
      'Content-Type': 'application/json',
    };

    const startedAt = Date.now();
    const created = await jsonRequest(`${isolateOrigin}/reviews`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        owner: meta.owner,
        repo: meta.repo,
        pullNumber: meta.pullNumber,
        headSha: meta.headSha,
        gitToken: E2E_GIT_TOKEN,
        model,
        thinkingEffort: selectedPrompt.thinkingEffort ?? null,
        dryRun: true,
        userPrompt,
      }),
    });
    const createdBody = asRecord(created.body);
    const runId = typeof createdBody?.runId === 'string' ? createdBody.runId : undefined;
    if (
      created.status !== 202 ||
      !runId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)
    ) {
      fail(
        `POST /reviews expected 202 { runId }, got ${created.status}; do not retry uncertain creation`
      );
    }
    console.log(`runId: ${runId}`);

    const deadline = Date.now() + TIMEOUT_MS;
    let status: ReviewStatus | undefined;
    while (Date.now() < deadline) {
      const polled = await jsonRequest(`${isolateOrigin}/reviews/${runId}`, {
        headers: authHeaders,
      });
      status = asRecord(polled.body) ?? { status: undefined };
      const pollState =
        status.status &&
        ['pending', 'cloning', 'running', 'completed', 'error'].includes(status.status)
          ? status.status
          : 'unknown';
      console.log(`poll ${Math.round((Date.now() - startedAt) / 1000)}s status=${pollState}`);
      if (status.status === 'completed' || status.status === 'error') break;
      await sleep(POLL_MS);
    }

    let transcript: Transcript | undefined;
    const messages = await jsonRequest(`${isolateOrigin}/reviews/${runId}/messages`, {
      headers: authHeaders,
    });
    const body = asRecord(messages.body);
    if (body) {
      transcript = {
        runId: body.runId,
        messages: Array.isArray(body.messages) ? body.messages : [],
        toolCalls: Array.isArray(body.toolCalls) ? body.toolCalls : [],
      };
    }

    const elapsedMs = Date.now() - startedAt;
    const writes = collectWrites(fixture);
    writeArtifacts({
      'status.json': status ?? null,
      'transcript.json': transcript ?? null,
      'writes.json': writes,
      'elapsed-ms.json': elapsedMs,
    });
    const tree = listTreeFiles();
    const hard = evaluateHardChecks({
      accepted: true,
      status,
      transcript,
      writes,
      tree,
      requireTaskCall: REQUIRE_TASK_CALL,
      expectedUserPrompt: userPrompt,
    });
    const soft = evaluateSoftNotes({ status, transcript, elapsedMs });
    const passed = hard.every(check => check.pass);
    const verdict = { passed, hard, soft, runId, isolateOrigin, fixtureOrigin: fixture.origin };
    writeArtifacts({
      'verdict.json': verdict,
    });

    printSummary(hard, soft, passed);
    exitCode = passed ? 0 : 1;
  } finally {
    const stop = asRecord(started)?.stop;
    if (typeof stop === 'function') {
      await (stop as (this: unknown) => Promise<void> | void).call(started);
    }
  }
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error(
      'Fixture run failed; no creation POST will be retried. Inspect private artifacts and fixture configuration.'
    );
    process.exitCode = 1;
  });
}
